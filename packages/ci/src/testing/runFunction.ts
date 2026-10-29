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

import { createHash } from "node:crypto";
import type { EventPayload, InngestFunction } from "inngest";
import { busOf, createdFunctions } from "./client.ts";
import type { BusEvent, EventBus } from "./eventBus.ts";
import { durationMs } from "./eventBus.ts";

/** The opcodes the harness reads; their values are the wire format. */
const StepOpCode = {
  InvokeFunction: "InvokeFunction",
  WaitForEvent: "WaitForEvent",
  StepError: "StepError",
  StepFailed: "StepFailed",
  StepPlanned: "StepPlanned",
  DeferAdd: "DeferAdd",
  DeferAbort: "DeferAbort",
  RunComplete: "RunComplete",
} as const;

/** The ID the SDK gives the op that ends a run, which is hashed like any step's. */
const runCompleteId = createHash("sha1").update("complete").digest("hex");

/** A defer a run registered and didn't abort, which starts when the run ends. */
export interface RegisteredDefer {
  /** The ID the run gave it. */
  id: string;
  /** The ID of the function it starts, with its app's. */
  functionSlug: string;
  /** What the function gets as `event.data`. */
  data: unknown;
}

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
  opts?: { span?: StepSpanPath; origin?: string };
  /** The step's ID before hashing. */
  userland?: { id: string };
}

/** The spans a step is grouped under, outermost first. */
type StepSpanPath = Array<{
  id: string;
  name: string;
  kind?: string;
  origin?: string;
}>;

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
  /** The span path of each step in a span, keyed by step ID. */
  spans: Record<string, StepSpanPath>;
  /** The origin of each step that has one, keyed by step ID. */
  origins: Record<string, string>;
  /**
   * The defers the run registered and did not abort, in the order it
   * registered them. They start when the run ends, however it ends.
   */
  defers: RegisteredDefer[];
  /**
   * What each `step.run` step was planned with, keyed by step ID: the options
   * the SDK sent the executor, such as a sandbox call's input.
   */
  inputs: Record<string, unknown>;
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
  /**
   * The functions `step.invoke` can reach. Defaults to every function the
   * test client created. An invoked function runs to completion like any
   * other, and its output or error comes back as the invoke's. Its
   * `concurrency` key limits steps running at once, not runs (see
   * `inTurn`).
   */
  functions?: InngestFunction.Any[];
  /**
   * Stop the run, as a cancel does, once this many execution requests have
   * been made. The result's type is `function-cancelled`; its defers are
   * what the run registered up to then.
   */
  cancelAfterRequests?: number;
  /** The run's ID. Defaults to `01TESTRUN`. */
  runId?: string;
  /** Set for a run another run started, which does not wait for the rest. */
  nested?: boolean;
  /**
   * Where every run in a test collects the defers it ended with, so the
   * outermost run's result has those of the runs it started too. Set by the
   * outermost run.
   */
  deferSink?: RegisteredDefer[];
}

let invokedRuns = 0;

/** Tails of the queues for each concurrency key, so steps of one key take turns. */
const keyQueues = new Map<string, Promise<unknown>>();

/** The value of a simple `event.data.<field>` concurrency key. */
const concurrencyKeyOf = (
  fn: InngestFunction.Any,
  event: EventPayload,
): string | undefined => {
  // biome-ignore lint/suspicious/noExplicitAny: reading the function's options
  const limits = (fn as any).opts?.concurrency as
    | { key?: string; limit: number }[]
    | undefined;

  const key = limits?.find((limit) => {
    return limit.limit === 1 && limit.key?.startsWith("event.data.");
  })?.key;

  if (!key) {
    return undefined;
  }

  const value = (event.data as Record<string, unknown>)[
    key.slice("event.data.".length)
  ];

  // biome-ignore lint/suspicious/noExplicitAny: reading the function's options
  return `${(fn as any).opts?.id}:${String(value)}`;
};

/**
 * Run `task` after every earlier one for `key`. The platform's `concurrency`
 * limits how many steps run at once, not how many runs are in flight, so this
 * wraps one step's execution and never a whole run: runs of one key interleave
 * between their steps.
 */
const inTurn = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const before = keyQueues.get(key) ?? Promise.resolve();
  const mine = before.then(task, task);

  keyQueues.set(
    key,
    mine.catch(() => {
      return undefined;
    }),
  );

  return mine;
};

/** Run an invoked function the way the executor would, and report the outcome. */
const runInvoked = async (
  caller: InngestFunction.Any,
  opts: RunFunctionOptions,
  planned: { id: string; opts?: unknown },
): Promise<{ data?: unknown; error?: unknown }> => {
  const call = planned.opts as {
    function_id: string;
    payload: { data?: unknown; meta?: EventPayload["meta"] };
  };

  const functions =
    opts.functions ??
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the SDK's internals
    createdFunctions.get((caller as any).client) ??
    [];

  // The executor finds a function by its app and ID, so with several apps'
  // functions in reach the app has to match too.
  const named = (exact: boolean) => {
    return functions.find((fn) => {
      // biome-ignore lint/suspicious/noExplicitAny: reaching into the SDK's internals
      const internals = fn as any;

      return exact
        ? call.function_id === `${internals.client.id}-${internals.opts.id}`
        : call.function_id.endsWith(`-${internals.opts.id}`);
    });
  };

  const target = named(true) ?? named(false);

  if (!target) {
    throw new Error(`No function to invoke for ${call.function_id}`);
  }

  // As on the wire, the payload and the result are JSON: a Date arrives as a
  // string and a Map as `{}`, and a value that can't be serialized fails the
  // invoke.
  let data: Record<string, unknown>;

  try {
    data = roundTrip(call.payload.data ?? {}) as Record<string, unknown>;
  } catch (error) {
    return { error: serializationError(error) };
  }

  const event: EventPayload = {
    name: "inngest/function.invoked",
    data,
    ...(call.payload.meta ? { meta: call.payload.meta } : {}),
  };

  invokedRuns++;

  const child = await runFunction(target, {
    ...opts,
    event,
    runId: `01TESTINVOKED${invokedRuns}`,
    nested: true,
  });

  if (child.type !== "function-resolved") {
    return { error: child.error };
  }

  try {
    return { data: roundTrip(child.data) };
  } catch (error) {
    return { error: serializationError(error) };
  }
};

/** What a value is after being sent as JSON. */
const roundTrip = (value: unknown): unknown => {
  const json = JSON.stringify(value);

  return json === undefined ? undefined : JSON.parse(json);
};

const serializationError = (error: unknown) => {
  return {
    name: "Error",
    message: `Could not serialize the invoke: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
};

const isFailed = (step: Step): boolean => {
  return step.op === StepOpCode.StepError || step.op === StepOpCode.StepFailed;
};

/** A step's ID as CI wrote it, since the executor's `id` is hashed. */
const stepId = (step: Step): string => {
  return step.userland?.id ?? step.id;
};

/**
 * Drive a function to completion the way the executor would. Its waits for
 * CI's own events, and the events its steps send, meet on the test client's
 * bus, and the runs those events start are driven too.
 */
export const runFunction = async (
  fn: InngestFunction.Any,
  opts: RunFunctionOptions = {},
): Promise<RunResult> => {
  // biome-ignore lint/suspicious/noExplicitAny: reaching into the SDK's internals
  const client = (fn as any).client as object;
  const bus = busOf(client);

  if (!bus) {
    return driveFunction(fn, withSink(opts));
  }

  wireEvents(client, bus, opts);

  bus.enter();

  try {
    return await driveFunction(fn, withSink(opts), bus);
  } finally {
    bus.leave();

    // The runs its events started end on their own, and a test looks at what
    // they left once its own run is over.
    if (!opts.nested) {
      await bus.drain();
    }
  }
};

const withSink = (opts: RunFunctionOptions): RunFunctionOptions => {
  return opts.nested ? opts : { ...opts, deferSink: opts.deferSink ?? [] };
};

const wired = new WeakSet<object>();
let startedRuns = 0;

/**
 * Start the build function on a request for a build, as the platform does,
 * skipping a request while one with the same `slot` runs (its singleton). The
 * options of the run that first used the client are the ones it runs with.
 */
const wireEvents = (
  client: object,
  bus: EventBus,
  opts: RunFunctionOptions,
): void => {
  if (wired.has(client)) {
    return;
  }

  wired.add(client);

  const running = new Set<string>();

  bus.listeners.push((event: BusEvent) => {
    // biome-ignore lint/suspicious/noExplicitAny: reading the client's ID
    const appId = (client as any).id as string;

    const build = (createdFunctions.get(client) ?? []).find((fn) => {
      // biome-ignore lint/suspicious/noExplicitAny: reading the function's options
      return (fn as any).opts?.id === "ci/build";
    });

    if (
      event.name !== "ci/build.requested" ||
      event.data.app !== appId ||
      !build
    ) {
      return;
    }

    const slot = String(event.data.slot);

    if (running.has(slot)) {
      bus.skipped++;

      return;
    }

    running.add(slot);

    bus.spawn(
      runFunction(build, {
        ...opts,
        event,
        runId: `01BUILD${++startedRuns}`,
        nested: true,
      }).then(() => {
        running.delete(slot);
      }),
    );
  });
};

const driveFunction = async (
  fn: InngestFunction.Any,
  opts: RunFunctionOptions,
  bus?: EventBus,
): Promise<RunResult> => {
  const event = opts.event ?? { name: "test/event", data: {} };
  const runId = opts.runId ?? "01TESTRUN";
  const maxRequests = opts.maxRequests ?? 200;
  const maxAttempts = opts.stepAttempts ?? 4;
  const retries = opts.retries ?? 0;
  const concurrencyKey = concurrencyKeyOf(fn, event);
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
  const spans: RunResult["spans"] = {};
  const origins: RunResult["origins"] = {};
  const inputs: Record<string, unknown> = {};
  const metadata: RunResult["metadata"] = [];

  const defers = new Map<string, RegisteredDefer>();
  const abortedDefers = new Set<string>();
  let requests = 0;

  const registeredDefers = (): RegisteredDefer[] => {
    return [...defers.values()];
  };

  // What the run ends with joins the sink, which the outermost run reports.
  const endedDefers = (): RegisteredDefer[] => {
    const own = registeredDefers();

    if (!opts.deferSink) {
      return own;
    }

    opts.deferSink.push(...own);

    return opts.nested ? own : [...opts.deferSink];
  };

  // The SDK ships what a run defers with whatever it sends next, and a run
  // that has been replayed ships it again, so each defer is kept once.
  const takeLazyOps = (steps: Step[]): Step[] => {
    return steps.filter((planned) => {
      if (planned.op === StepOpCode.DeferAbort) {
        const target = (planned.opts as { target_hashed_id?: string })
          ?.target_hashed_id;

        if (target) {
          abortedDefers.add(target);
          defers.delete(target);
        }

        return false;
      }

      if (planned.op === StepOpCode.DeferAdd) {
        const added = planned.opts as unknown as {
          fn_slug: string;
          input: unknown;
        };

        if (!abortedDefers.has(planned.id) && !defers.has(planned.id)) {
          defers.set(planned.id, {
            id: stepId(planned),
            functionSlug: added.fn_slug,
            data: added.input,
          });
        }

        return false;
      }

      return true;
    });
  };

  // A request that carries defers comes back as a batch of ops. This turns it
  // back into what it would have been without them.
  const request = async (runStep?: string): Promise<ExecutionResult> => {
    opts.beforeRequest?.();

    requests++;

    const result = await runOnce(
      fn,
      event,
      stepState,
      completionOrder,
      attempt,
      runId,
      runStep,
    );

    if (result.type !== "steps-found" || !result.steps) {
      return result;
    }

    const rest = takeLazyOps(result.steps);
    const ending = rest.find((planned) => {
      return (
        planned.op === StepOpCode.RunComplete ||
        (planned.id === runCompleteId &&
          (planned.op === StepOpCode.StepFailed ||
            planned.op === StepOpCode.StepError))
      );
    });

    if (ending?.op === StepOpCode.RunComplete) {
      return { type: "function-resolved", data: ending.data };
    }

    if (ending) {
      return {
        type: "function-rejected",
        error: ending.error ?? ending.data,
        retriable: ending.op === StepOpCode.StepError,
      };
    }

    // A step that ran, with the defers it registered.
    if (runStep && rest.length === 1 && rest[0]?.id === runStep) {
      return {
        type: "step-ran",
        step: rest[0],
        retriable: rest[0].op !== StepOpCode.StepFailed,
      };
    }

    return { ...result, steps: rest };
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

    // The SDK stamps a step's spans and origin on it.
    const { span, origin } = step.opts ?? {};

    if (span) {
      spans[id] = span;
    }

    if (origin) {
      origins[id] = origin;
    }
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

  // Invokes run beside the function, as they do on the platform: the function
  // is called again as soon as any one of them ends, without waiting for the
  // rest. Their outcomes are only recorded between requests, so a request
  // never sees state change underneath it.
  const inflight = new Map<string, Promise<void>>();
  const drops = new Set<() => void>();
  const started = new Set<string>();

  const finished: Array<{
    planned: Step;
    outcome?: { data?: unknown; error?: unknown };
    thrown?: unknown;
  }> = [];

  const settleInvokes = (): void => {
    for (const { planned, outcome, thrown } of finished.splice(0)) {
      if (thrown !== undefined) {
        throw thrown;
      }

      record({
        id: planned.id,
        ...(planned.userland ? { userland: planned.userland } : {}),
        ...(planned.displayName === undefined
          ? {}
          : { displayName: planned.displayName }),
        opts: planned.opts,
        ...(outcome?.error === undefined
          ? { data: outcome?.data ?? null }
          : { error: outcome.error }),
      });
    }
  };

  for (let i = 0; i < maxRequests; i++) {
    settleInvokes();

    if (
      opts.cancelAfterRequests !== undefined &&
      requests >= opts.cancelAfterRequests
    ) {
      for (const drop of drops) {
        drop();
      }

      // The runs it started stop as it does, and their defers are part of
      // what the cancel leaves.
      await untilSettled(bus, () => {
        return Promise.allSettled(inflight.values());
      });

      return {
        type: "function-cancelled",
        stepIds,
        batches,
        names,
        steps,
        spans,
        origins,
        defers: endedDefers(),
        inputs,
        metadata,
      };
    }

    let progressed = false;

    const result = await request();

    if (result.type === "function-resolved") {
      // A wait nothing has ended does not hold the run open: the run completes
      // and the executor drops the wait.
      for (const drop of drops) {
        drop();
      }

      return {
        type: result.type,
        data: result.data,
        stepIds,
        batches,
        names,
        steps,
        spans,
        origins,
        defers: endedDefers(),
        inputs,
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
        spans,
        origins,
        defers: endedDefers(),
        inputs,
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

    // An invoke that is still running is planned again by every request.
    const fresh = (result.steps ?? []).filter((planned) => {
      return !started.has(planned.id);
    });

    if (fresh.length > 0) {
      batches.push(
        fresh.map((planned) => {
          return stepId(planned);
        }),
      );
    }

    for (const planned of result.steps ?? []) {
      if (planned.op === StepOpCode.InvokeFunction) {
        if (started.has(planned.id)) {
          continue;
        }

        started.add(planned.id);

        inputs[stepId(planned)] = planned.opts;

        progressed = true;

        inflight.set(
          planned.id,
          runInvoked(fn, opts, planned).then(
            (outcome) => {
              finished.push({ planned, outcome });
              inflight.delete(planned.id);
            },
            (thrown) => {
              finished.push({ planned, thrown: thrown ?? new Error("invoke") });
              inflight.delete(planned.id);
            },
          ),
        );

        continue;
      }

      // A wait for one of CI's events is a pause on the bus, saved now, so
      // events sent from here on reach it. It stays open beside the function
      // like an invoke.
      if (
        planned.op === StepOpCode.WaitForEvent &&
        bus &&
        String(planned.name).startsWith("ci/")
      ) {
        if (started.has(planned.id)) {
          continue;
        }

        started.add(planned.id);

        progressed = true;

        const wait = planned.opts as { timeout: string; if?: string };

        const pause = bus.pause(
          String(planned.name),
          wait.if,
          durationMs(wait.timeout),
        );

        drops.add(pause.drop);

        inflight.set(
          planned.id,
          pause.event.then((matched) => {
            finished.push({ planned, outcome: { data: matched } });
            inflight.delete(planned.id);
            drops.delete(pause.drop);
          }),
        );

        continue;
      }

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
          opts: planned.opts,
        });

        progressed = true;

        continue;
      }

      inputs[stepId(planned)] = planned.opts;

      const ran = await (concurrencyKey
        ? inTurn(concurrencyKey, () => {
            return request(planned.id);
          })
        : request(planned.id));

      progressed = true;

      if (ran.type === "step-ran") {
        recordRan(ran);
      }
    }

    // Nothing new to do, so the function is waiting on its invokes.
    if (!progressed && finished.length === 0 && inflight.size > 0) {
      await untilSettled(bus, () => {
        return Promise.race(inflight.values());
      });
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
  runId: string,
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
      // Separate objects, as on the wire: a defer function strips its metadata
      // off each in place, so no request may see another's.
      data: {
        event: structuredClone(event),
        events: [structuredClone(event)],
        runId,
        attempt,
      },
      runId,
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

/** How many invoked functions have run, for a test to count builds with. */
export const invokedRunCount = (): number => {
  return invokedRuns;
};

/** Wait, telling the bus the run can do nothing until something else happens. */
const untilSettled = (
  bus: EventBus | undefined,
  wait: () => Promise<unknown>,
): Promise<unknown> => {
  return bus ? bus.blockedOn(wait) : wait();
};
