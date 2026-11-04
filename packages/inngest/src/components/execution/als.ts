import type { QuestionBook } from "../../experimental/agents/inbox/questionBook.ts";
import type { ReportBook } from "../../experimental/agents/inbox/reports.ts";
import type { AgentLoopWiring } from "../../experimental/agents/loop/loop.ts";
import type { AgentScoreFn } from "../../experimental/agents/loop/scores.ts";
import type { Context, StepOptions, StepSpan } from "../../types.ts";
import type { Inngest } from "../Inngest.ts";
import type { Stream } from "../StreamTools.ts";
import type { SandboxTools } from "../sandbox/tools.ts";
import type { IInngestExecution } from "./InngestExecution.ts";
import type { InboxRead } from "./inboxState.ts";

/**
 * Note - this structure can be used by other libraries, so cannot have breaking changes.
 */
/**
 * What `agent.loop()` reads to wire itself to the agent's inbox, budget and turn record.
 */
export interface AgentBridge {
  wiring?: AgentLoopWiring;

  /**
   * The run's `score`, which a tool's context shares so that the run waits
   * for a score a tool did not await.
   */
  score?: AgentScoreFn;

  /**
   * The questions this run received, answered and asked, which the model's
   * `reply` and `ask_agent` tools read and write.
   */
  questions?: QuestionBook;

  /**
   * Whether the run was opened through a handle, so it ends after its answer
   * and waits for the children it started.
   */
  handleOpened?: boolean;

  /**
   * The typed reports the run was started with and the types it has sent.
   */
  reports?: ReportBook;

  /**
   * The agent tools sandbox code can call as `tools.<name>(...)` in a `runCode`
   * the run lists: discovery, `start_agent`, `message_agent`, `stop_agent` and
   * `agent_result`, which `discovery: false` leaves out, and `report` when the
   * run owes reports.
   */
  codeTools?: SandboxTools;
}

export interface AsyncContext {
  /**
   * The Inngest App that is currently being used to execute the function.
   *
   * If this is defined, we are in the context of an Inngest function execution,
   * or a possible one.
   */
  app: Inngest.Like;

  /**
   * Set inside a background reader (`withoutStepCount`): the step tools it
   * calls are not counted by `stepsIssued`.
   */
  uncounted?: boolean;

  /**
   * Details of the current function execution context. If this doesn't exist,
   * then we're not currently in a function execution context.
   */
  execution?: {
    /**
     * The execution instance that is currently running the function.
     */
    instance: IInngestExecution;

    /**
     * The ID of the function being executed, when the engine knows it.
     */
    functionId?: string;

    /**
     * The `ctx` object that has been passed in to this function execution,
     * including values such as `step` and `event`.
     */
    ctx: Context.Any;

    /**
     * If present, this indicates we are currently executing a `step.run()` step's
     * callback. Useful to understand whether we are in the context of a step
     * execution or within the main function body.
     */
    executingStep?: StepOptions & {
      hashedId?: string;
      userlandId?: string;
    };

    /**
     * If present, indicates the parallel mode that should be applied to steps
     * created within this context. Set by `group.parallel()`.
     */
    parallelMode?: "race";

    /**
     * If present, the spans that steps created within this context are
     * grouped under, outermost first. Set by `group["~span"]()`.
     */
    span?: (StepSpan & { name: string })[];

    /**
     * If present, prefixes the ID of every step created within this context,
     * and stops those steps inheriting their span's origin. Set by
     * `withStepIdPrefix()`.
     */
    stepIdPrefix?: string;

    /**
     * The stream tools instance for this execution context. Used by the
     * `stream` singleton to push/pipe SSE data to the client.
     */
    stream?: Stream;

    /**
     * If present, indicates the variant callback is executing within an
     * experiment. Set by `group.experiment()`. Any `step.*()` call within
     * this context will include these fields in `OutgoingOp.opts`.
     */
    experimentContext?: {
      experimentStepID: string;
      experimentName: string;
      variant: string;
      selectionStrategy: string;
    };

    /**
     * A mutable tracker used to detect whether any step tool was invoked
     * during a variant callback. Set by `group.experiment()`, flipped by
     * `createTool` in `InngestStepTools.ts`.
     */
    experimentStepTracker?: { found: boolean };

    /**
     * If true, we are inside the `select()` callback of
     * `group.experiment()`. Any `step.*()` call here would create a
     * nested step, which is not allowed.
     */
    insideExperimentSelect?: boolean;

    /**
     * If present, the thread of an agent run whose trigger event
     * does not carry them. Set by the agent function; read by the agent KV.
     */
    agent?: { thread: string; ref?: string };

    /**
     * What the executor said it supports on this request. Undefined when
     * unknown.
     */
    executorCapabilities?: string[];

    /**
     * What an inbox (`step.subscribe()`) reads from the run's state: its
     * messages in the order the executor saved them, and the last step of the
     * stack this request loaded.
     */
    inbox?: {
      read: (inbox: string, taken: number, wait: string) => InboxRead;
      unread: (inbox: string, taken: number, upTo?: string) => string[];
      message: (id: string) => unknown;
      lastSeen: () => string;

      /**
       * Settles when replay reaches the message step `id` in the run's stack,
       * after every found step earlier in the stack has been handed back.
       */
      place: (id: string) => Promise<void>;
    };

    /**
     * Tells the engine that a step was skipped because its answer was already
     * in the state, so it is not waited for. Only inboxes use it.
     */
    skipStep?: (id: string) => Promise<void>;

    /**
     * The inbox control of the agent run this function execution is, set by the
     * agent function once it exists. `agent.loop()` uses it to steer
     * when it is not given its own.
     */
    agentBridge?: AgentBridge;

    /**
     * The answer the run's state holds for a step, if it has one. Only
     * inboxes use it, to tell a read that timed out from one that has not
     * been answered.
     */
    stepAnswer?: (id: string) => { found: boolean; data?: unknown };
  };
}

const issuedSteps = new WeakMap<object, number>();

/**
 * Notes that the code of `instance` called a step tool. Replays run the same
 * code, so the count at any point of the code is the same on every request.
 * A call from a background reader is not counted: how far such a reader gets
 * before a given point of the code depends on what the request loaded, so
 * counting it would make the count differ between replays.
 */
export const countStepIssued = (instance: object): void => {
  if (getAsyncCtxSync()?.uncounted) {
    return;
  }

  issuedSteps.set(instance, (issuedSteps.get(instance) ?? 0) + 1);
};

/**
 * Runs `fn`, and everything it starts, as a background reader: the step tools
 * it calls are not counted by `stepsIssued`. Internal.
 * @param fn What reads in the background.
 */
export const withoutStepCount = <R>(fn: () => R): R => {
  const store = getAsyncCtxSync();

  return store ? runWithAsyncCtx({ ...store, uncounted: true }, fn) : fn();
};

/**
 * How many step tools the code of this execution has called so far, or
 * `undefined` outside one. Unlike what the state holds, it is the same at a
 * given point of the code on a first run and on a replay.
 */
export const stepsIssued = (): number | undefined => {
  const instance = getAsyncCtxSync()?.execution?.instance;

  return instance ? (issuedSteps.get(instance) ?? 0) : undefined;
};

/**
 * A local-only symbol used as a key in global state to store the async local
 * storage instance.
 */
const alsSymbol = Symbol.for("inngest:als");

/**
 * Cache structure that stores both the promise and resolved ALS instance.
 * This allows synchronous access after initialization.
 */
type ALSCache = {
  promise: Promise<AsyncLocalStorageIsh>;
  resolved?: AsyncLocalStorageIsh;
  isFallback?: boolean;
};

/**
 * A type that represents a partial, runtime-agnostic interface of
 * `AsyncLocalStorage`.
 */
type AsyncLocalStorageIsh = {
  getStore: () => AsyncContext | undefined;
  run: <R>(store: AsyncContext, fn: () => R) => R;
};

const getCache = (): ALSCache => {
  const g = globalThis as Record<symbol, ALSCache | undefined>;

  if (!g[alsSymbol]) {
    g[alsSymbol] = createCache();
  }

  return g[alsSymbol];
};

const createCache = (): ALSCache => {
  const cache = {} as ALSCache;
  cache.promise = initializeALS(cache);
  return cache;
};

const initializeALS = async (
  cache: ALSCache,
): Promise<AsyncLocalStorageIsh> => {
  try {
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const als = new AsyncLocalStorage<AsyncContext>();
    cache.resolved = als;
    cache.isFallback = false;
    return als;
  } catch {
    const fallback: AsyncLocalStorageIsh = {
      getStore: () => undefined,
      run: (_, fn) => fn(),
    };
    cache.resolved = fallback;
    cache.isFallback = true;
    console.warn(
      "node:async_hooks is not supported in this runtime. Async context is disabled.",
    );
    return fallback;
  }
};

/**
 * Check if AsyncLocalStorage is unavailable and we're using the fallback.
 * Returns `undefined` if ALS hasn't been initialized yet.
 */
export const isALSFallback = (): boolean | undefined => {
  return getCache().isFallback;
};

/**
 * Retrieve the async context for the current execution.
 */
export const getAsyncCtx = async (): Promise<AsyncContext | undefined> => {
  return getAsyncLocalStorage().then((als) => als.getStore());
};

/**
 * Retrieve the async context for the current execution synchronously.
 * Returns undefined if ALS hasn't been initialized yet.
 */
export const getAsyncCtxSync = (): AsyncContext | undefined => {
  return getCache().resolved?.getStore();
};

/**
 * Run a function within a specific async context if AsyncLocalStorage has
 * already been initialized.
 */
export const runWithAsyncCtx = <R>(store: AsyncContext, fn: () => R): R => {
  const als = getCache().resolved;
  if (!als) {
    return fn();
  }

  return als.run(store, fn);
};

/**
 * Get a singleton instance of `AsyncLocalStorage` used to store and retrieve
 * async context for the current execution.
 */
export const getAsyncLocalStorage = async (): Promise<AsyncLocalStorageIsh> => {
  return getCache().promise;
};
