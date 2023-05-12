import canonicalize from "canonicalize";
import { sha1 } from "hash.js";
import { type Jsonify } from "type-fest";
import { ErrCode, functionStoppedRunningErr } from "../helpers/errors";
import { timeStr } from "../helpers/strings";
import {
  type ObjectPaths,
  type PartialK,
  type SendEventPayload,
  type SingleOrArray,
  type ValueOf,
} from "../helpers/types";
import {
  StepOpCode,
  type EventPayload,
  type HashedOp,
  type Op,
} from "../types";
import { type Inngest } from "./Inngest";
import { NonRetriableError } from "./NonRetriableError";

export interface TickOp extends HashedOp {
  fn?: (...args: unknown[]) => unknown;
  fulfilled: boolean;
  resolve: (value: unknown | PromiseLike<unknown>) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Create a new set of step function tools ready to be used in a step function.
 * This function should be run and a fresh set of tools provided every time a
 * function is run.
 *
 * An op stack (function state) is passed in as well as some mutable properties
 * that the tools can use to submit a new op.
 */
export const createStepTools = <
  Events extends Record<string, EventPayload>,
  TriggeringEvent extends keyof Events & string
>(
  client: Inngest<Events>
) => {
  const state: {
    /**
     * The tree of all found ops in the entire invocation.
     */
    allFoundOps: Record<string, TickOp>;

    /**
     * All synchronous operations found in this particular tick. The array is
     * reset every tick.
     */
    tickOps: Record<string, TickOp>;

    /**
     * A hash of operations found within this tick, with keys being the hashed
     * ops themselves (without a position) and the values being the number of
     * times that op has been found.
     *
     * This is used to provide some mutation resilience to the op stack,
     * allowing us to survive same-tick mutations of code by ensuring per-tick
     * hashes are based on uniqueness rather than order.
     */
    tickOpHashes: Record<string, number>;

    /**
     * Tracks the current operation being processed. This can be used to
     * understand the contextual parent of any recorded operations.
     */
    currentOp: TickOp | undefined;

    /**
     * If we've found a user function to run, we'll store it here so a component
     * higher up can invoke and await it.
     */
    userFnToRun?: (...args: unknown[]) => unknown;

    /**
     * A boolean to represent whether the user's function is using any step
     * tools.
     *
     * If the function survives an entire tick of the event loop and hasn't
     * touched any tools, we assume that it is a single-step async function and
     * should be awaited as usual.
     */
    hasUsedTools: boolean;

    /**
     * A function that should be used to reset the state of the tools after a
     * tick has completed.
     */
    reset: () => void;

    /**
     * If `true`, any use of step tools will, by default, throw an error. We do
     * this when we detect that a function may be mixing step and non-step code.
     *
     * Created step tooling can decide how to manually handle this on a
     * case-by-case basis.
     *
     * In the future, we can provide a way for a user to override this if they
     * wish to and understand the danger of side-effects.
     *
     * Defaults to `false`.
     */
    nonStepFnDetected: boolean;

    /**
     * When true, we are currently executing a user's code for a single step
     * within a step function.
     */
    executingStep: boolean;
  } = {
    allFoundOps: {},
    tickOps: {},
    tickOpHashes: {},
    currentOp: undefined,
    hasUsedTools: false,
    reset: () => {
      state.tickOpHashes = {};
      state.allFoundOps = { ...state.allFoundOps, ...state.tickOps };
    },
    nonStepFnDetected: false,
    executingStep: false,
  };

  // Start referencing everything
  state.tickOps = state.allFoundOps;

  /**
   * Create a unique hash of an operation using only a subset of the operation's
   * properties; will never use `data` and will guarantee the order of the object
   * so we don't rely on individual tools for that.
   */
  const hashOp = (
    /**
     * The op to generate a hash from. We only use a subset of the op's properties
     * when creating the hash.
     */
    op: Op
  ): HashedOp => {
    const obj = {
      parent: state.currentOp?.id ?? null,
      op: op.op,
      name: op.name,
      opts: op.opts ?? null,
    };

    const collisionHash = _internals.hashData(obj);

    const pos = (state.tickOpHashes[collisionHash] =
      (state.tickOpHashes[collisionHash] ?? -1) + 1);

    return {
      ...op,
      id: _internals.hashData({ pos, ...obj }),
    };
  };

  /**
   * A local helper used to create tools that can be used to submit an op.
   *
   * When using this function, a generic type should be provided which is the
   * function signature exposed to the user.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createTool = <T extends (...args: any[]) => Promise<unknown>>(
    /**
     * A function that returns an ID for this op. This is used to ensure that
     * the op stack is correctly filled, submitted, and retrieved with the same
     * ID.
     *
     * It is passed the arguments passed by the user.
     *
     * Most simple tools will likely only need to define this.
     */
    matchOp: (
      /**
       * Arguments passed by the user.
       */
      ...args: Parameters<T>
    ) => Omit<Op, "data" | "error">,

    opts?: {
      /**
       * Optionally, we can also provide a function that will be called when
       * Inngest tells us to run this operation.
       *
       * If this function is defined, the first time the tool is used it will
       * report the desired operation (including options) to the Inngest. Inngest
       * will then call back to the function to tell it to run the step and then
       * retrieve data.
       *
       * We do this in order to allow functionality such as per-step retries; this
       * gives the SDK the opportunity to tell Inngest what it wants to do before
       * it does it.
       *
       * This function is passed the arguments passed by the user. It will be run
       * when we receive an operation matching this one that does not contain a
       * `data` property.
       */
      fn?: (...args: Parameters<T>) => unknown;

      /**
       * If `true` and we have detected that this is a  non-step function, the
       * provided `fn` will be called and the result returned immediately
       * instead of being executed later.
       *
       * If no `fn` is provided to the tool, this will throw the same error as
       * if this setting was `false`.
       */
      nonStepExecuteInline?: boolean;
    }
  ): T => {
    return ((...args: Parameters<T>): Promise<unknown> => {
      if (state.nonStepFnDetected) {
        if (opts?.nonStepExecuteInline && opts.fn) {
          return Promise.resolve(opts.fn(...args));
        }

        throw new NonRetriableError(
          functionStoppedRunningErr(ErrCode.STEP_USED_AFTER_ASYNC)
        );
      }

      state.hasUsedTools = true;

      const opId = hashOp(matchOp(...args));

      return new Promise<unknown>((resolve, reject) => {
        state.tickOps[opId.id] = {
          ...opId,
          ...(opts?.fn ? { fn: () => opts.fn?.(...args) } : {}),
          resolve,
          reject,
          fulfilled: false,
        };
      });
    }) as T;
  };

  /**
   * Define the set of tools the user has access to for their step functions.
   *
   * Each key is the function name and is expected to run `createTool` and pass
   * a generic type for that function as it will appear in the user's code.
   */
  const tools = {
    /**
     * Send one or many events to Inngest. Should always be used in place of
     * `inngest.send()` to ensure that the event send is successfully retried
     * and not sent multiple times due to memoisation.
     *
     * @example
     * ```ts
     * await step.sendEvent("app/user.created", { data: { id: 123 } });
     *
     * await step.sendEvent({ name: "app/user.created", data: { id: 123 } });
     *
     * await step.sendEvent([
     *   {
     *     name: "app/user.created",
     *     data: { id: 123 },
     *   },
     *   {
     *     name: "app/user.feed.created",
     *     data: { id: 123 },
     *   },
     * ]);
     * ```
     *
     * Returns a promise that will resolve once the event has been sent.
     */
    sendEvent: createTool<{
      <Payload extends SendEventPayload<Events>>(
        payload: Payload
      ): Promise<void>;
      <Event extends keyof Events & string>(
        name: Event,
        payload: SingleOrArray<
          PartialK<Omit<Events[Event], "name" | "v">, "ts">
        >
      ): Promise<void>;
    }>(
      (nameOrPayload, maybePayload) => {
        let payloads: ValueOf<Events>[];

        if (typeof nameOrPayload === "string") {
          /**
           * Add our payloads and ensure they all have a name.
           */
          payloads = (Array.isArray(maybePayload)
            ? maybePayload
            : maybePayload
            ? [maybePayload]
            : []
          ).map((payload) => ({
            ...payload,
            name: nameOrPayload,
          })) as unknown as typeof payloads;
        } else {
          /**
           * Grab our payloads straight from the args.
           */
          payloads = (
            Array.isArray(nameOrPayload)
              ? nameOrPayload
              : nameOrPayload
              ? [nameOrPayload]
              : []
          ) as typeof payloads;
        }

        return {
          op: StepOpCode.StepPlanned,
          name: payloads[0]?.name || "sendEvent",
        };
      },
      {
        nonStepExecuteInline: true,
        fn: (nameOrPayload, maybePayload) => {
          return client.send(nameOrPayload, maybePayload);
        },
      }
    ),

    /**
     * Wait for a particular event to be received before continuing. When the
     * event is received, it will be returned.
     *
     * You can also provide options to control the particular event that is
     * received, for example to ensure that a user ID matches between two
     * events, or to only wait a maximum amount of time before giving up and
     * returning `null` instead of any event data.
     */
    waitForEvent: createTool<
      <IncomingEvent extends keyof Events | EventPayload>(
        event: IncomingEvent extends keyof Events
          ? IncomingEvent
          : IncomingEvent extends EventPayload
          ? IncomingEvent["name"]
          : never,
        opts:
          | string
          | ((IncomingEvent extends keyof Events
              ? WaitForEventOpts<Events[TriggeringEvent], Events[IncomingEvent]>
              : IncomingEvent extends EventPayload
              ? WaitForEventOpts<Events[TriggeringEvent], IncomingEvent>
              : never) & {
              if?: never;
            })
          | ((IncomingEvent extends keyof Events
              ? WaitForEventOpts<Events[TriggeringEvent], Events[IncomingEvent]>
              : IncomingEvent extends EventPayload
              ? WaitForEventOpts<Events[TriggeringEvent], IncomingEvent>
              : never) & {
              match?: never;
            })
      ) => Promise<
        IncomingEvent extends keyof Events
          ? Events[IncomingEvent] | null
          : IncomingEvent | null
      >
    >(
      (
        /**
         * The event name to wait for.
         */
        event,

        /**
         * Options to control the event we're waiting for.
         */
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        opts: WaitForEventOpts<any, any> | string
      ) => {
        const matchOpts: { timeout: string; if?: string } = {
          timeout: timeStr(typeof opts === "string" ? opts : opts.timeout),
        };

        if (typeof opts !== "string") {
          if (opts?.match) {
            matchOpts.if = `event.${opts.match} == async.${opts.match}`;
          } else if (opts?.if) {
            matchOpts.if = opts.if;
          }
        }

        return {
          op: StepOpCode.WaitForEvent,
          name: event as string,
          opts: matchOpts,
        };
      }
    ),

    /**
     * Use this tool to run business logic. Each call to `run` will be retried
     * individually, meaning you can compose complex workflows that safely
     * retry dependent asynchronous actions.
     *
     * The function you pass to `run` will be called only when this "step" is to
     * be executed and can be synchronous or asynchronous.
     *
     * In either case, the return value of the function will be the return value
     * of the `run` tool, meaning you can return and reason about return data
     * for next steps.
     */
    run: createTool<
      <T extends () => unknown>(
        /**
         * The name of this step as it will appear in the Inngest Cloud UI. This
         * is also used as a unique identifier for the step and should not match
         * any other steps within this step function.
         */
        name: string,

        /**
         * The function to run when this step is executed. Can be synchronous or
         * asynchronous.
         *
         * The return value of this function will be the return value of this
         * call to `run`, meaning you can return and reason about return data
         * for next steps.
         */
        fn: T
      ) => Promise<
        Jsonify<
          T extends () => Promise<infer U>
            ? Awaited<U extends void ? null : U>
            : ReturnType<T> extends void
            ? null
            : ReturnType<T>
        >
      >
    >(
      (name) => {
        return {
          op: StepOpCode.StepPlanned,
          name,
        };
      },
      { fn: (_, fn) => fn() }
    ),

    /**
     * Wait a specified amount of time before continuing.
     *
     * The time to wait can be specified using a `number` of milliseconds or an
     * `ms`-compatible time string like `"1 hour"`, `"30 mins"`, or `"2.5d"`.
     *
     * {@link https://npm.im/ms}
     *
     * To wait until a particular date, use `sleepUntil` instead.
     */
    sleep: createTool<
      (
        /**
         * The amount of time to wait before continuing.
         */
        time: number | string
      ) => Promise<void>
    >((time) => {
      /**
       * The presence of this operation in the returned stack indicates that the
       * sleep is over and we should continue execution.
       */
      return {
        op: StepOpCode.Sleep,
        name: timeStr(time),
      };
    }),

    /**
     * Wait until a particular date before continuing by passing a `Date`.
     *
     * To wait for a particular amount of time from now, always use `sleep`
     * instead.
     */
    sleepUntil: createTool<
      (
        /**
         * The date to wait until before continuing.
         */
        time: Date | string
      ) => Promise<void>
    >((time) => {
      const date = typeof time === "string" ? new Date(time) : time;

      /**
       * The presence of this operation in the returned stack indicates that the
       * sleep is over and we should continue execution.
       */
      try {
        return {
          op: StepOpCode.Sleep,
          name: date.toISOString(),
        };
      } catch (err) {
        /**
         * If we're here, it's because the date is invalid. We'll throw a custom
         * error here to standardise this response.
         */
        // TODO PrettyError
        console.warn("Invalid date or date string passed to sleepUntil;", err);

        // TODO PrettyError
        throw new Error(
          `Invalid date or date string passed to sleepUntil: ${time.toString()}`
        );
      }
    }),
  };

  return [tools, state] as [typeof tools, typeof state];
};

/**
 * A set of optional parameters given to a `waitForEvent` call to control how
 * the event is handled.
 */
interface WaitForEventOpts<
  TriggeringEvent extends EventPayload,
  IncomingEvent extends EventPayload
> {
  /**
   * The step function will wait for the event for a maximum of this time, at
   * which point the event will be returned as `null` instead of any event data.
   *
   * The time to wait can be specified using a `number` of milliseconds, an
   * `ms`-compatible time string like `"1 hour"`, `"30 mins"`, or `"2.5d"`, or
   * a `Date` object.
   *
   * {@link https://npm.im/ms}
   */
  timeout: number | string | Date;

  /**
   * If provided, the step function will wait for the incoming event to match
   * particular criteria. If the event does not match, it will be ignored and
   * the step function will wait for another event.
   *
   * It must be a string of a dot-notation field name within both events to
   * compare, e.g. `"data.id"` or `"user.email"`.
   *
   * ```
   * // Wait for an event where the `user.email` field matches
   * match: "user.email"
   * ```
   *
   * All of these are helpers for the `if` option, which allows you to specify
   * a custom condition to check. This can be useful if you need to compare
   * multiple fields or use a more complex condition.
   *
   * See the Inngest expressions docs for more information.
   *
   * {@link https://www.inngest.com/docs/functions/expressions}
   */
  match?: ObjectPaths<TriggeringEvent> & ObjectPaths<IncomingEvent>;

  /**
   * If provided, the step function will wait for the incoming event to match
   * the given condition. If the event does not match, it will be ignored and
   * the step function will wait for another event.
   *
   * The condition is a string of Google's Common Expression Language. For most
   * simple cases, you might prefer to use `match` instead.
   *
   * See the Inngest expressions docs for more information.
   *
   * {@link https://www.inngest.com/docs/functions/expressions}
   */
  if?: string;
}

/**
 * An operation ready to hash to be used to memoise step function progress.
 *
 * @internal
 */
export type UnhashedOp = {
  name: string;
  op: StepOpCode;
  opts: Record<string, unknown> | null;
  parent: string | null;
  pos?: number;
};

const hashData = (op: UnhashedOp): string => {
  return sha1().update(canonicalize(op)).digest("hex");
};

/**
 * Exported for testing.
 */
export const _internals = { hashData };
