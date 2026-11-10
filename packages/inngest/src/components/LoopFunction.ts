import type { internalEvents } from "../helpers/consts.ts";
import { type DurationInput, durationToMs } from "../helpers/duration.ts";
import { type Marker, markerKey } from "../helpers/marker.ts";
import { timeStr } from "../helpers/strings.ts";
import type { AsArray, SingleOrArray } from "../helpers/types.ts";
import type {
  ApplyAllMiddlewareCtxExtensions,
  ApplyAllMiddlewareGroupExtensions,
  ApplyAllMiddlewareStepExtensions,
  BaseContext,
  FunctionConfig,
  Handler,
} from "../types.ts";
import type {
  FSMTools,
  LoopInput,
  LoopKind,
  LoopTools,
} from "./execution/loop.ts";
import {
  type builtInMiddleware,
  type ClientOptionsFromInngest,
  type Inngest,
  internalLoggerSymbol,
} from "./Inngest.ts";
import { InngestFunction } from "./InngestFunction.ts";
import type { GroupTools } from "./InngestGroupTools.ts";
import type { createStepTools } from "./InngestStepTools.ts";
import type { Middleware } from "./middleware/index.ts";
import type { ReceivedEvent, ToReceivedEvent } from "./triggers/typeHelpers.ts";

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * a loop or fsm made with `createLoop()` or `createFSM()`.  it is an
 * `InngestFunction` with a `loop` block in its sync config, which makes the
 * server keep one state record per key and run one input per key at a time.
 *
 * `isLoopFunction(value)` from `helpers/marker.ts` identifies one.
 * `instanceof` fails when two copies of the SDK are loaded.
 *
 * @public
 */
export class LoopFunction<
  TState extends LoopFunction.State = LoopFunction.State,
  TKind extends LoopKind = LoopKind,
> extends InngestFunction<
  InngestFunction.Options<InngestFunction.Trigger<string>[], never>,
  Handler.Any,
  never,
  Inngest.Any,
  InngestFunction.Trigger<string>[]
> {
  readonly [markerKey]: Marker = { kind: "LoopFunction" };

  /**
   * the `loop` block of the sync config.
   */
  readonly loop: NonNullable<FunctionConfig["loop"]> & { kind: TKind };

  /**
   * the state an instance has before its first commit.  each run gets a copy.
   */
  readonly initialState: TState;

  constructor(
    client: Inngest.Any,
    kind: TKind,
    opts: LoopFunction.Options<TState>,
    handler: Handler.Any,
  ) {
    const name = kind === "fsm" ? "createFSM" : "createLoop";

    if (typeof handler !== "function") {
      throw new Error(
        `"${name}" expected a handler function as the third argument`,
      );
    }

    const { key, tick, idleTTL, state, ...rest } = opts;
    const fnOpts = rest as InngestFunction.Options<
      InngestFunction.Trigger<string>[],
      never
    >;

    if (typeof key !== "string" || key === "") {
      throw new Error(`"${name}" requires a "key" expression`);
    }
    if (!fnOpts.triggers?.length) {
      throw new Error(`"${name}" requires at least one trigger`);
    }
    if (fnOpts.singleton) {
      throw new Error("loops and singletons are mutually exclusive");
    }
    if (fnOpts.batchEvents) {
      throw new Error("loops and batching are mutually exclusive");
    }
    if (fnOpts.debounce) {
      throw new Error("loops and debouncing are mutually exclusive");
    }
    if (fnOpts.onFailure) {
      throw new Error("loops do not support onFailure");
    }
    for (const limit of [fnOpts.concurrency ?? []].flat()) {
      if (typeof limit === "object" && limit.key) {
        throw new Error(
          "loops and keyed concurrency limits are mutually exclusive.  a loop always runs one input per key",
        );
      }
    }

    if (typeof state !== "object" || state === null) {
      throw new Error(`"${name}" requires "state" to be an object or an array`);
    }
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(state);
    } catch (err) {
      throw new Error(`"${name}" could not encode "state" as JSON`, {
        cause: err,
      });
    }
    if (encoded === undefined || encoded === "null") {
      throw new Error(`"${name}" requires "state" to encode to a JSON value`);
    }

    super(client, fnOpts, handler);

    const logger = client[internalLoggerSymbol];
    this.initialState = state;
    this.loop = {
      kind,
      key,
    };
    if (tick !== undefined) {
      this.loop.tick = timeStr(durationToMs(tick, { name: "tick" }), logger);
    }
    if (idleTTL !== undefined) {
      this.loop.idle_ttl = timeStr(
        durationToMs(idleTTL, { name: "idleTTL" }),
        logger,
      );
    }
  }

  protected override getConfigLoop(): FunctionConfig["loop"] {
    return { ...this.loop };
  }
}

/**
 * @public
 */
export namespace LoopFunction {
  /**
   * matches any `LoopFunction`, whatever its state and kind.
   */
  // biome-ignore lint/suspicious/noExplicitAny: widest state constraint
  export type Any = LoopFunction<any, LoopKind>;

  /**
   * the state of a loop instance.  the handler changes it in place, so it is
   * an object or an array.  the server stores it as JSON.
   */
  export type State = Record<string, unknown> | unknown[];

  /**
   * the options of `createLoop()` and `createFSM()` after the triggers are
   * made an array.
   *
   * `singleton`, `batchEvents`, and `debounce` are not accepted, because a
   * loop runs one input per run and one run per key.  `onFailure` is not
   * supported.
   */
  export type Options<TState extends State = State> = Omit<
    InngestFunction.Options<InngestFunction.Trigger<string>[], never>,
    | "singleton"
    | "batchEvents"
    | "debounce"
    | "onFailure"
    | "optimizeParallelism"
    | "experimentalCheckpointing"
  > & {
    /**
     * a CEL expression over the event that names the instance, such as
     * `"event.data.app_id"`.  each key has its own state, and the server runs
     * one input per key at a time.  an event whose key is empty starts no
     * run.
     */
    key: string;

    /**
     * the server runs the instance again this long after a run for the key
     * finishes.  one tick is pending per key at most.  that run has
     * `input.kind` set to "tick".
     */
    tick?: DurationInput;

    /**
     * the server deletes the instance when no run commits state for this
     * long.
     */
    idleTTL?: DurationInput;

    /**
     * the state an instance has before its first commit.
     */
    state: TState;
  };
}

/**
 * the event of a run that the tick interval started.
 */
export type LoopTickEvent = ReceivedEvent<
  `${internalEvents.LoopTick}`,
  {
    key: string;
  }
>;

/**
 * the event of a run that a wake started.  `data.id` is the wake id.
 */
export type LoopWakeEvent = ReceivedEvent<
  `${internalEvents.LoopWake}`,
  {
    key: string;
    id: string;
  }
>;

/**
 * the events a loop handler gets.  a loop can subscribe to any event, so its
 * union has an event with any name.  an fsm gets only its triggers, the tick,
 * and the wake.
 */
type LoopEvent<
  TTriggers extends InngestFunction.Trigger<string>[],
  TKind extends LoopKind,
> =
  | ToReceivedEvent<TTriggers>[number]
  | LoopTickEvent
  | LoopWakeEvent
  | (TKind extends "loop"
      ? // biome-ignore lint/suspicious/noExplicitAny: a subscribed event has no schema
        ReceivedEvent<string, Record<string, any>>
      : never);

/**
 * the step tools of a loop handler.  the tools that park the run are left
 * out.  a parked run holds the loop key, so a loop waits with `loop.wake()`
 * or `loop.subscribe()` and returns.
 */
type LoopStepTools<
  TClient extends Inngest.Any,
  TFnMiddleware extends Middleware.Class[] | undefined,
> = Omit<
  ReturnType<typeof createStepTools<TClient, TFnMiddleware>> &
    ApplyAllMiddlewareStepExtensions<
      ClientOptionsFromInngest<TClient>["middleware"]
    > &
    ApplyAllMiddlewareStepExtensions<TFnMiddleware>,
  "sleep" | "sleepUntil" | "waitForEvent" | "waitForSignal"
>;

type BaseLoopCtx<
  TClient extends Inngest.Any,
  TFnMiddleware extends Middleware.Class[] | undefined,
  TTriggers extends InngestFunction.Trigger<string>[],
  TState extends LoopFunction.State,
  TKind extends LoopKind,
> = Omit<
  BaseContext<TClient>,
  "event" | "events" | "step" | "group" | "defer"
> & {
  event: LoopEvent<TTriggers, TKind>;
  events: [LoopEvent<TTriggers, TKind>];

  /**
   * the state of this instance.  change it in place.  the SDK sends it to
   * the server when the handler returns, and the server commits it.  a
   * handler that throws commits nothing.
   *
   * do not change it inside `step.run()`.  a memoized step does not run its
   * callback again, so the change is lost on the next request of the run.
   */
  state: TState;

  /**
   * what started this run.
   */
  input: LoopInput;

  /**
   * the calls that say what happens after this run.
   */
  loop: TKind extends "fsm" ? FSMTools : LoopTools;

  step: LoopStepTools<TClient, TFnMiddleware>;

  group: GroupTools &
    ApplyAllMiddlewareGroupExtensions<
      ClientOptionsFromInngest<TClient>["middleware"]
    > &
    ApplyAllMiddlewareGroupExtensions<TFnMiddleware>;
};

/**
 * the handler context of a loop or fsm.  it is `BaseLoopCtx` with every
 * middleware context extension that applies.
 */
export type LoopContext<
  TClient extends Inngest.Any,
  TFnMiddleware extends Middleware.Class[] | undefined,
  TTriggers extends InngestFunction.Trigger<string>[],
  TState extends LoopFunction.State,
  TKind extends LoopKind,
> = BaseLoopCtx<TClient, TFnMiddleware, TTriggers, TState, TKind> &
  ApplyAllMiddlewareCtxExtensions<[...ReturnType<typeof builtInMiddleware>]> &
  ApplyAllMiddlewareCtxExtensions<
    ClientOptionsFromInngest<TClient>["middleware"]
  > &
  ApplyAllMiddlewareCtxExtensions<TFnMiddleware>;

/**
 * a loop or fsm handler.  it returns nothing.  it keeps data by changing
 * `state`.
 */
export type LoopHandler<
  TClient extends Inngest.Any,
  TFnMiddleware extends Middleware.Class[] | undefined,
  TTriggers extends InngestFunction.Trigger<string>[],
  TState extends LoopFunction.State,
  TKind extends LoopKind,
> = (
  ctx: LoopContext<TClient, TFnMiddleware, TTriggers, TState, TKind>,
) => void | Promise<void>;

/**
 * the input of `createLoop()` and `createFSM()`.  it is
 * `LoopFunction.Options` with `triggers` as one trigger or an array.
 */
export type CreateLoopInput<
  TState extends LoopFunction.State,
  TTriggers extends SingleOrArray<InngestFunction.Trigger<string>>,
  TFnMiddleware extends Middleware.Class[] | undefined,
> = Omit<LoopFunction.Options<TState>, "triggers" | "middleware"> & {
  triggers: TTriggers;
  middleware?: TFnMiddleware;
};

type ResolveTriggers<
  TTriggers extends SingleOrArray<InngestFunction.Trigger<string>>,
> = AsArray<TTriggers>;

const build = <TState extends LoopFunction.State, TKind extends LoopKind>(
  client: Inngest.Any,
  kind: TKind,
  options: CreateLoopInput<
    TState,
    SingleOrArray<InngestFunction.Trigger<string>>,
    Middleware.Class[] | undefined
  >,
  handler: unknown,
): LoopFunction<TState, TKind> => {
  const triggers = options?.triggers;

  return new LoopFunction<TState, TKind>(
    client,
    kind,
    {
      ...options,
      triggers:
        triggers === undefined || Array.isArray(triggers)
          ? triggers
          : [triggers],
    } as LoopFunction.Options<TState>,
    handler as Handler.Any,
  );
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * creates a loop.  a loop is a function with one state record per key.  each
 * input for a key is one run, and the server runs one input per key at a
 * time.  an input is a trigger event, a tick, a wake, or a subscribed event.
 *
 * the handler changes `state` in place and returns nothing.  the server
 * commits the state when the handler returns and commits nothing when it
 * throws.  the handler waits with `loop.wake()` or `loop.subscribe()` and a
 * return.  `step.sleep()` and `step.waitForEvent()` are not allowed.
 *
 * pass the result to `serve()` with the other functions.
 *
 * @example
 * ```ts
 * const counter = createLoop(
 *   inngest,
 *   {
 *     id: "counter",
 *     triggers: [{ event: "app/thing.happened" }],
 *     key: "event.data.user_id",
 *     tick: "1h",
 *     state: { count: 0 },
 *   },
 *   async ({ event, input, state, step, loop }) => {
 *     if (input.kind === "event") {
 *       state.count++;
 *     }
 *
 *     if (state.count >= 10) {
 *       return loop.end();
 *     }
 *
 *     return loop.wake("remind", "10m");
 *   },
 * );
 * ```
 */
export function createLoop<
  TClient extends Inngest.Any,
  TState extends LoopFunction.State,
  const TTriggers extends SingleOrArray<InngestFunction.Trigger<string>>,
  const TFnMiddleware extends Middleware.Class[] | undefined = undefined,
>(
  client: TClient,
  options: CreateLoopInput<TState, TTriggers, TFnMiddleware>,
  handler: LoopHandler<
    TClient,
    TFnMiddleware,
    ResolveTriggers<TTriggers>,
    TState,
    "loop"
  >,
): LoopFunction<TState, "loop"> {
  return build(client, "loop", options, handler);
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * creates an fsm.  an fsm is a loop that cannot subscribe to events.  its
 * inputs are its trigger events, the tick, and wakes.  see `createLoop()`.
 *
 * pass the result to `serve()` with the other functions.
 */
export function createFSM<
  TClient extends Inngest.Any,
  TState extends LoopFunction.State,
  const TTriggers extends SingleOrArray<InngestFunction.Trigger<string>>,
  const TFnMiddleware extends Middleware.Class[] | undefined = undefined,
>(
  client: TClient,
  options: CreateLoopInput<TState, TTriggers, TFnMiddleware>,
  handler: LoopHandler<
    TClient,
    TFnMiddleware,
    ResolveTriggers<TTriggers>,
    TState,
    "fsm"
  >,
): LoopFunction<TState, "fsm"> {
  return build(client, "fsm", options, handler);
}
