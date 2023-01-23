import { sha1 } from "hash.js";
import sigmund from "sigmund";
import { Jsonify } from "type-fest";
import { timeStr } from "../helpers/strings";
import type { ObjectPaths } from "../helpers/types";
import { EventPayload, HashedOp, Op, OpStack, StepOpCode } from "../types";

/**
 * A unique class used to interrupt the flow of a step. It is intended to be
 * thrown and caught using `instanceof StepFlowInterrupt`.
 */
export class StepFlowInterrupt {}

/**
 * Create a new set of step function tools ready to be used in a step function.
 * This function should be run and a fresh set of tools provided every time a
 * function is run.
 *
 * An op stack (function state) is passed in as well as some mutable properties
 * that the tools can use to submit a new op.
 *
 * Broadly, each tool is responsible for potentially filling itself with data
 * from the op stack and submitting an op, interrupting the step function when
 * it does so.
 *
 * This feels better being a class, but class bindings are lost (i.e. `this`
 * becomes `undefined`) if a user destructures the tools within their step
 * function. Thus, we must instead use closures for this functionality.
 */
export const createStepTools = <
  Events extends Record<string, EventPayload>,
  TriggeringEvent extends keyof Events
>(
  _opStack: OpStack
) => {
  /**
   * A boolean to represent that we're currently running through the op stack of
   * the function to decide what to do next.
   *
   * When we've finished reading the op stack to set the function's state and
   * have a new operation to run, we set this to `false` to indicate that we've
   * found the next operation and will no longer attempt any other actions.
   *
   * We use this instead of `Boolean(state.nextOp)` because some operations may
   * accidentally not set `state.nextOp`, so we need another way to know that we
   * have found the next potential operation.
   */
  let readingFromStack = true;

  /**
   * We use pos to ensure that hashes are unique for each step and a function
   * will produce the same IDs and outputs every time.
   *
   * Each time attempt to fetch data for an operation, we increment this value
   * and include it in the hash for that op.
   */
  let pos = 0;

  /**
   * Perform a shallow clone of the opstack to ensure we're not removing
   * elements from the original.
   */
  const opStack = { ..._opStack };

  /**
   * Returns [true, any] if the next op matches the next past op.
   *
   * Returns [false, undefined] if the next op didn't match or we ran out of
   * stack. In either case, we should run the next op.
   */
  const getNextPastOpData = (
    op: HashedOp
  ): [found: false, data: undefined] | [found: true, data: any] => {
    const next: unknown = opStack[op.id];
    // if the data is undefined, it hasn't ran.  Any other data, such
    // as false, null, etc. indicates that the step has already ran as
    // state was persisted.
    return [next !== undefined, next as any];
  };

  /**
   * A local helper used to create tools that can be used to submit an op.
   *
   * It will handle filling any data from the op stack and will provide tools to
   * a given function to safely submit synchronous or asynchronous ops.
   *
   * When using this function, a generic type should be provided which is the
   * function signature exposed to the user.
   */
  const createTool = <T extends (...args: any[]) => any>(
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
    ) => Op,

    /**
     * Optionally, we can also provide a function that will be called with the
     * data passed by the user in order to submit a new op.
     *
     * By default - if this is not provided - this will be a simple function
     * that runs the `submitOp()` tool passed to it.
     *
     * This is useful for tools that need to do some kind of async processing
     * before submitting an op, or tools that need to adjust the op they're
     * submitting.
     */
    fn?: (
      {
        submitOp,
      }: {
        /**
         * Use this to submit the next operation for the step function to
         * Inngest.
         *
         * If the `fn` containing this parameter isn't defined, the entire
         * function will default to just running this `submitOp` tool, so if
         * that's all you're doing then you might not need to define this.
         */
        submitOp: (data?: Op["data"]) => void;
      },
      ...args: Parameters<T>
    ) => any
  ): T => {
    return ((...args: Parameters<T>) => {
      /**
       * If we already have the next op to run, then we've already received
       * output from another tool and should no longer continue.
       */
      if (!readingFromStack) {
        throw new StepFlowInterrupt();
      }

      /**
       * Fetch the next op to run from the tool we want to run.
       */
      const unhashedOpId: Op = matchOp(...args);

      /**
       * Hash the operation ID.
       */
      const opId: HashedOp = {
        ...unhashedOpId,
        id: hashOp(unhashedOpId, pos++),
      };

      const [found, data] = getNextPastOpData(opId);

      if (found) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return data;
      }

      /**
       * Set `readingFromStack` to false to indicate that we've found the next
       * op to run.
       */
      readingFromStack = false;

      const submitOp: Parameters<
        NonNullable<Parameters<typeof createTool>[1]>
      >[0]["submitOp"] = (...args) => {
        state.nextOp = new Promise((resolve) => resolve(args[0])).then(
          (data) => ({
            ...opId,
            ...(args.length ? { data } : {}),
          })
        );
      };

      /**
       * If we've been passed a custom function to run in response to user data,
       * run that now. That function will then be responsible for submitting an
       * op.
       *
       * If we haven't been given this, simply submit the op.
       */
      if (fn) {
        fn({ submitOp }, ...args);
      } else {
        submitOp();
      }

      /**
       * If we've run the tool and it hasn't submitted an op, then we should
       * throw. This is exceedingly unexpected and indicates that a tool has
       * a bug.
       */
      if (!state.nextOp) {
        throw new Error("No operation was submitted by a tool");
      }

      /**
       * If we're here, we've attempted to use a tool and should therefore throw
       * an error to stop the function from running.
       */
      throw new StepFlowInterrupt();
    }) as T;
  };

  const state: {
    nextOp: Promise<HashedOp> | undefined;
  } = {
    nextOp: undefined,
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
      ) => IncomingEvent extends keyof Events
        ? Events[IncomingEvent] | null
        : IncomingEvent | null
    >(
      (
        /**
         * The event name to wait for.
         */
        event,

        /**
         * Options to control the event we're waiting for.
         */
        opts: WaitForEventOpts<any, any>
      ) => {
        const matchOpts: { timeout: string; if?: string } = {
          timeout: timeStr(opts.timeout),
        };

        if (opts?.match) {
          matchOpts.if = `event.${opts.match} == async.${opts.match}`;
        } else if (opts?.if) {
          matchOpts.if = opts.if;
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
      <T extends (...args: any[]) => any>(
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
      ) => Jsonify<
        T extends (...args: any[]) => Promise<infer U>
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
      ({ submitOp }, _name, fn) => {
        submitOp(fn());
      }
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
      ) => void
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
      ) => void
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
        console.warn("Invalid date or date string passed to sleepUntil;", err);

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
   * compare, e.g. `"date.id"` or `"user.email"`.
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
