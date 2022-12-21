import { sha1 } from "hash.js";
import sigmund from "sigmund";
import { timeStr } from "../helpers/strings";
import type { ObjectPaths } from "../helpers/types";
import { EventPayload, HashedOp, Op, StepOpCode } from "../types";

export interface TickOp extends HashedOp {
  tickOps: TickOp[];
  fn?: (...args: any[]) => any;
  resolve: (value: any | PromiseLike<any>) => void;
  reject: (reason?: any) => void;
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
  TriggeringEvent extends keyof Events
>() => {
  const state: {
    allFoundOps: TickOp[];
    pos: number;
    tickOps: TickOp[];
    userFnToRun?: (...args: any[]) => any;

    /**
     * A boolean to represent whether the user's function is using any step
     * tools.
     *
     * If the function survives an entire tick of the event loop and hasn't
     * touched any tools, we assume that it is a single-step async function and
     * should be awaited as usual.
     */
    hasUsedTools: boolean;
  } = {
    allFoundOps: [],
    pos: -1,
    tickOps: [],
    hasUsedTools: false,
  };

  // Start referencing everything
  state.tickOps = state.allFoundOps;

  /**
   * A local helper used to create tools that can be used to submit an op.
   *
   * It will handle filling any data from the op stack and will provide tools to
   * a given function to safely submit synchronous or asynchronous ops.
   *
   * When using this function, a generic type should be provided which is the
   * function signature exposed to the user.
   */
  const createTool = <T extends (...args: any[]) => Promise<any>>(
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
    ) => Omit<Op, "data" | "run" | "opPosition">,

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
    fn?: (...args: Parameters<T>) => any
  ): T => {
    // eslint-disable-next-line @typescript-eslint/require-await
    return ((...args: Parameters<T>): Promise<any> => {
      state.hasUsedTools = true;

      const unhashedOpId: Op = matchOp(...args);
      const opId: HashedOp = {
        ...unhashedOpId,
        id: hashOp(unhashedOpId, state.tickOps.length),
      };

      return new Promise<any>((resolve, reject) => {
        state.tickOps.push({
          ...opId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          ...(fn ? { fn: () => fn(...args) } : {}),
          tickOps: [],
          resolve,
          reject,
        });
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
      <T extends () => any>(
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
        T extends () => Promise<infer U>
          ? Awaited<U extends void ? null : U>
          : ReturnType<T> extends void
          ? null
          : ReturnType<T>
      >
    >(
      (name) => {
        return {
          op: StepOpCode.RunStep,
          name,
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      (_, fn) => fn()
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
     * To wait for a particular amount of time, use `sleep` instead.
     */
    sleepUntil: createTool<
      (
        /**
         * The date to wait until before continuing.
         */
        time: Date
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
 * Create a unique hash of an operation using only a subset of the operation's
 * properties; will never use `data` and will guarantee the order of the object
 * so we don't rely on individual tools for that.
 */
const hashOp = (
  /**
   * The op to generate a hash from. We only use a subset of the op's properties
   * when creating the hash.
   */
  op: Op,

  /**
   * The position in the "stack" that this was called from. We use this to
   * ensure that the hash is unique for each step and in-line with what we
   * expect the stack to be.
   */
  pos: number
): string => {
  return (
    sha1()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      .update(sigmund({ pos, op: op.op, name: op.name, opts: op.opts }))
      .digest("hex")
  );
};
