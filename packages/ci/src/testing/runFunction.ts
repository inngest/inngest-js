/**
 * Drives an Inngest function to completion the way the executor would, for
 * tests: run whatever step it plans, feed the result back, and go again.
 *
 * This reaches into the SDK's internals (`client`, `createExecution`) on
 * purpose. There is no public way to run one execution request in-process with
 * the function's middleware attached, and CI functions need that middleware for
 * `step.sandbox`. `@inngest/test` was evaluated and can't do this yet: it
 * builds executions without middleware instances, doesn't retry failed steps,
 * and needs every wait mocked by hand. The SDK's own tests reach in the same
 * way. If `createExecution` changes, this is the one file to fix.
 *
 * @module
 */

import type { EventPayload, InngestFunction } from "inngest";

/** The opcodes the harness reads; their values are the wire format. */
const StepOpCode = {
  StepError: "StepError",
  StepFailed: "StepFailed",
  StepPlanned: "StepPlanned",
} as const;

/** A metadata update a step carried on its result, as the executor gets it. */
export interface MetadataUpdate {
  kind: string;
  scope: string;
  op: string;
  values: Record<string, unknown>;
}

/** A step as the executor reports it, whether planned or just run. */
interface Step {
  id: string;
  op?: string;
  displayName?: string;
  name?: string;
  data?: unknown;
  error?: unknown;
  metadata?: MetadataUpdate[];
  /** The step's ID before hashing. */
  userland?: { id: string };
}

/** One execution request's outcome, loosely typed: the SDK doesn't export it. */
interface ExecutionResult {
  type: string;
  data?: unknown;
  error?: unknown;
  retriable?: unknown;
  step?: Step;
  steps?: Step[];
}

export interface RunResult {
  type: string;
  data?: unknown;
  error?: unknown;
  /** For a rejected run, whether the executor would retry it. */
  retriable?: unknown;
  /** Step IDs, before hashing, in the order the steps completed. */
  stepIds: string[];
  /**
   * The step IDs each request found at once, in request order. Steps in one
   * batch were found while none of them had finished, so they run in parallel.
   */
  batches: string[][];
  /** Each step's display name, keyed by step ID. */
  names: Record<string, string>;
  /** Step data keyed by step ID. */
  steps: Record<string, unknown>;
  /**
   * Metadata updates in the order steps ran them, each with the ID of the step
   * that carried it. A step that fails and retries carries its metadata on
   * every attempt, so it can appear more than once.
   */
  metadata: Array<MetadataUpdate & { step: string }>;
}

export interface RunFunctionOptions {
  event?: EventPayload;
  /** How many execution requests to make before giving up. Defaults to 200. */
  maxRequests?: number;
  /**
   * What a sleep or wait resolves to. Defaults to `null`, which is what a
   * `waitForEvent` timeout looks like.
   */
  resolveWait?: (step: { id: string; displayName?: string }) => unknown;
  /** How many times a retriable step failure is retried. Defaults to 4. */
  stepAttempts?: number;
  /**
   * How many times a function that fails retriably is run again, with its
   * step results kept and `attempt` counting up. Defaults to 0.
   */
  retries?: number;
  /** Called before each execution request, such as to advance a fake clock. */
  beforeRequest?: () => void;
}

const isFailed = (step: Step): boolean => {
  return step.op === StepOpCode.StepError || step.op === StepOpCode.StepFailed;
};

/** A step's ID as CI wrote it, since the executor's `id` is hashed. */
const stepId = (step: Step): string => {
  return step.userland?.id ?? step.id;
};

/**
 * Drive a function to completion the way the executor would.
 */
export const runFunction = async (
  fn: InngestFunction.Any,
  opts: RunFunctionOptions = {},
): Promise<RunResult> => {
  const event = opts.event ?? { name: "test/event", data: {} };
  const maxRequests = opts.maxRequests ?? 200;
  const maxAttempts = opts.stepAttempts ?? 4;
  const retries = opts.retries ?? 0;
  let attempt = 0;

  // The state the executor would send back on each request.
  const stepState: Record<
    string,
    { id: string; data?: unknown; error?: unknown }
  > = {};

  const completionOrder: string[] = [];
  const attempts = new Map<string, number>();

  const stepIds: string[] = [];
  const batches: string[][] = [];
  const names: Record<string, string> = {};
  const steps: Record<string, unknown> = {};
  const metadata: RunResult["metadata"] = [];

  const request = async (runStep?: string): Promise<ExecutionResult> => {
    opts.beforeRequest?.();

    return runOnce(fn, event, stepState, completionOrder, attempt, runStep);
  };

  const record = (step: Step): void => {
    // A failed step reports its error in both `data` and `error`; the executor
    // only keeps the error, and replaying with both would resolve the step
    // with the serialized error instead of throwing it.
    stepState[step.id] = {
      id: step.id,
      ...(isFailed(step) || step.data === undefined ? {} : { data: step.data }),
      ...(step.error === undefined ? {} : { error: step.error }),
    };

    completionOrder.push(step.id);

    const id = stepId(step);

    stepIds.push(id);

    names[id] = step.displayName ?? step.name ?? id;

    steps[id] = step.data;
  };

  // The executor retries a step that failed retriably, and only writes the
  // error into state once the attempts run out. Without this, a step that
  // fails once (a flaky command, a bad first SDK response) would look
  // permanently broken.
  const recordRan = (result: ExecutionResult): void => {
    const step = result.step;

    if (!step) {
      return;
    }

    for (const update of step.metadata ?? []) {
      metadata.push({
        step: stepId(step),
        ...update,
      });
    }

    if (isFailed(step) && result.retriable !== false) {
      const seen = (attempts.get(step.id) ?? 0) + 1;

      attempts.set(step.id, seen);

      if (seen < maxAttempts) {
        return;
      }
    }

    record(step);
  };

  for (let i = 0; i < maxRequests; i++) {
    const result = await request();

    if (result.type === "function-resolved") {
      return {
        type: result.type,
        data: result.data,
        stepIds,
        batches,
        names,
        steps,
        metadata,
      };
    }

    if (result.type === "function-rejected") {
      if (result.retriable !== false && attempt < retries) {
        attempt++;

        continue;
      }

      return {
        type: result.type,
        error: result.error,
        retriable: result.retriable,
        stepIds,
        batches,
        names,
        steps,
        metadata,
      };
    }

    if (result.type === "step-ran") {
      recordRan(result);

      continue;
    }

    if (result.type !== "steps-found") {
      throw new Error(`Unexpected execution result: ${result.type}`);
    }

    if ((result.steps ?? []).length > 0) {
      batches.push(
        (result.steps ?? []).map((planned) => {
          return stepId(planned);
        }),
      );
    }

    for (const planned of result.steps ?? []) {
      // Only `step.run` steps are asked to run. Everything else (sleeps,
      // waits) is fulfilled by the executor writing state, so the harness
      // does the same.
      if (planned.op && planned.op !== StepOpCode.StepPlanned) {
        record({
          id: planned.id,
          ...(planned.userland ? { userland: planned.userland } : {}),
          ...(planned.displayName === undefined
            ? {}
            : { displayName: planned.displayName }),
          data: opts.resolveWait ? opts.resolveWait(planned) : null,
        });

        continue;
      }

      const ran = await request(planned.id);

      if (ran.type === "step-ran") {
        recordRan(ran);
      }
    }
  }

  throw new Error(`Function did not settle within ${maxRequests} requests`);
};

/** Make one execution request, optionally asking it to run a single step. */
const runOnce = async (
  fn: InngestFunction.Any,
  event: EventPayload,
  stepState: object,
  completionOrder: string[],
  attempt: number,
  runStep?: string,
): Promise<ExecutionResult> => {
  // biome-ignore lint/suspicious/noExplicitAny: reaching into the SDK's internals, see the module comment
  const internals = fn as any;
  const client = internals["client"];

  // `serve()` appends function-level middleware to the client's once it knows
  // which function is running. Executions created directly don't, so this does
  // the same to keep `step.sandbox` available.
  const middlewareInstances = [
    ...client.middleware,
    ...(internals.opts?.middleware ?? []),
    // biome-ignore lint/suspicious/noExplicitAny: middleware constructors
  ].map((Middleware: any) => {
    return new Middleware({ client });
  });

  const execution = internals["createExecution"]({
    partialOptions: {
      client,
      data: { event, events: [event], runId: "01TESTRUN", attempt },
      runId: "01TESTRUN",
      stepState,
      stepCompletionOrder: completionOrder,
      handlerKind: "main",
      requestedRunStep: runStep,
      disableImmediateExecution: true,
      reqArgs: [],
      headers: {},
      stepMode: "async",
      queueItemId: "fake-queue-item-id",
      middlewareInstances,
    },
  });

  const { ctx: _ctx, ops: _ops, ...result } = await execution.start();

  return result;
};
