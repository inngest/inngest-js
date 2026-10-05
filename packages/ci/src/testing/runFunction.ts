/**
 * Drives an Inngest function to completion the way the executor would, for
 * tests.
 *
 * @module
 */

import type { EventPayload, InngestFunction } from "inngest";

/** The executor opcodes the harness reads; their values are the wire format. */
const StepOpCode = {
  StepError: "StepError",
  StepFailed: "StepFailed",
  StepPlanned: "StepPlanned",
} as const;

type StepState = Record<
  string,
  { id: string; data?: unknown; error?: unknown }
>;

export interface RunResult {
  type: string;
  data?: unknown;
  error?: unknown;
  /** For a rejected run, whether the executor would retry it. */
  retriable?: unknown;
  /**
   * Step names in the order they completed. The executor hashes IDs, so these
   * are the display names CI gave each step.
   */
  stepIds: string[];
  /** Step data keyed by display name. */
  steps: Record<string, unknown>;
}

/**
 * Drive a function to completion the way the executor would: run whatever
 * step it plans, feed the result back, and go again.
 */
export const runFunction = async (
  fn: InngestFunction.Any,
  opts: {
    event?: EventPayload;
    maxRequests?: number;
    /**
     * What a sleep or wait resolves to. Defaults to `null`, which is what a
     * `waitForEvent` timeout looks like.
     */
    resolveWait?: (step: { id: string; displayName?: string }) => unknown;
    /** How many times a retriable step failure is retried. Defaults to 4. */
    stepAttempts?: number;
  } = {},
): Promise<RunResult> => {
  const stepState: StepState = {};
  const stepOrder: string[] = [];
  const names: string[] = [];
  const steps: Record<string, unknown> = {};
  const maxRequests = opts.maxRequests ?? 200;

  type RanStep = {
    id: string;
    op?: string;
    displayName?: string;
    name?: string;
    data?: unknown;
    error?: unknown;
  };

  const attempts = new Map<string, number>();
  const maxAttempts = opts.stepAttempts ?? 4;

  /**
   * The executor retries a step that failed retriably, and only writes the
   * error into state once the attempts run out. Without this, a step that
   * fails once — a flaky command, an SDK call with a bad first response —
   * would look permanently broken.
   */
  const shouldRetry = (step: RanStep, retriable: unknown): boolean => {
    const failed =
      step.op === StepOpCode.StepError || step.op === StepOpCode.StepFailed;

    if (!failed || retriable === false) {
      return false;
    }

    const seen = (attempts.get(step.id) ?? 0) + 1;
    attempts.set(step.id, seen);

    return seen < maxAttempts;
  };

  const record = (step: RanStep) => {
    // A failed step reports its error in both `data` and `error`; the executor
    // only keeps the error, and replaying with both would resolve the step
    // with the serialized error instead of throwing it.
    const failed =
      step.op === StepOpCode.StepError || step.op === StepOpCode.StepFailed;

    stepState[step.id] = {
      id: step.id,
      ...(failed || step.data === undefined ? {} : { data: step.data }),
      ...(step.error === undefined ? {} : { error: step.error }),
    };
    stepOrder.push(step.id);

    const label = step.displayName ?? step.name ?? step.id;
    names.push(label);
    steps[label] = step.data;
  };

  for (let request = 0; request < maxRequests; request++) {
    const result = await runOnce(fn, stepState, stepOrder, opts.event);

    if (result.type === "function-resolved") {
      return {
        type: result.type,
        data: (result as { data: unknown }).data,
        stepIds: [...names],
        steps,
      };
    }

    if (result.type === "function-rejected") {
      return {
        type: result.type,
        error: (result as { error: unknown }).error,
        retriable: (result as { retriable?: unknown }).retriable,
        stepIds: [...names],
        steps,
      };
    }

    if (result.type === "step-ran") {
      const ranStep = (result as { step: RanStep; retriable?: unknown }).step;

      if (shouldRetry(ranStep, (result as { retriable?: unknown }).retriable)) {
        continue;
      }

      record(ranStep);
      continue;
    }

    if (result.type === "steps-found") {
      const planned = (result as { steps: (RanStep & { op?: string })[] })
        .steps;

      for (const plannedStep of planned) {
        // Only `step.run` steps are asked to run. Everything else — sleeps,
        // waits — is fulfilled by the executor writing state, so the harness
        // does the same.
        if (plannedStep.op && plannedStep.op !== StepOpCode.StepPlanned) {
          record({
            id: plannedStep.id,
            ...(plannedStep.displayName === undefined
              ? {}
              : { displayName: plannedStep.displayName }),
            data: opts.resolveWait
              ? opts.resolveWait(plannedStep)
              : (null as unknown),
          });
          continue;
        }

        const ran = await runOnce(
          fn,
          stepState,
          stepOrder,
          opts.event,
          plannedStep.id,
        );

        if (ran.type !== "step-ran") {
          continue;
        }

        const ranStep = (ran as { step: RanStep }).step;

        if (shouldRetry(ranStep, (ran as { retriable?: unknown }).retriable)) {
          continue;
        }

        record(ranStep);
      }

      continue;
    }

    throw new Error(`Unexpected execution result: ${result.type}`);
  }

  throw new Error(`Function did not settle within ${maxRequests} requests`);
};

const runOnce = async (
  fn: InngestFunction.Any,
  stepState: StepState,
  stepOrder: string[],
  event?: EventPayload,
  runStep?: string,
) => {
  // biome-ignore lint/suspicious/noExplicitAny: reaching into the SDK's internals like the other tests do
  const anyFn = fn as any;
  const client = anyFn["client"];

  // `serve()` appends function-level middleware to the client's once it knows
  // which function is running. Executions created directly don't, so this does
  // the same thing to keep `step.sandbox` available.
  const middlewareInstances = [
    ...client.middleware,
    ...(anyFn.opts?.middleware ?? []),
    // biome-ignore lint/suspicious/noExplicitAny: middleware constructors
  ].map((Cls: any) => new Cls({ client }));

  const execution = anyFn["createExecution"]({
    partialOptions: {
      client,
      data: {
        event: event ?? { name: "test/event", data: {} },
        events: [event ?? { name: "test/event", data: {} }],
        runId: "01TESTRUN",
        attempt: 0,
      },
      runId: "01TESTRUN",
      stepState,
      stepCompletionOrder: stepOrder,
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

  const { ctx: _ctx, ops: _ops, ...rest } = await execution.start();
  return rest;
};
