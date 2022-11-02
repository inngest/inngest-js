import { dateToTimeStr } from "../helpers/strings";
import type { ObjectPaths, Primitive } from "../helpers/types";
import { EventPayload, Op, OpStack, StepOpCode, TimeStr } from "../types";

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
   * Controls whether these toolsets are active or not. Exposed tools should
   * watch this value to decide what action to perform. It is most likely that
   * if this boolean is `false` then they should immediately interrupt flow.
   */
  let active = true;

  /**
   * Perform a shallow clone of the opstack to ensure we're not removing
   * elements from the original.
   */
  const opStack = [..._opStack];

  /**
   * Returns [true, any] if the next op matches the next past op.
   *
   * Returns [false, undefined] if the next op didn't match or we ran out of
   * stack. In either case, we should run the next op.
   */
  const getNextPastOpData = (
    op: Op
  ): [found: false, data: undefined] | [found: true, data: any] => {
    const next = opStack.shift();

    /**
     * If we had no next op, return fail case.
     */
    if (!next) return [false, undefined];

    /**
     * Check if op matches, returning fail case if it doesn't.
     */
    const opMatches = (["op", "id"] as (keyof Op)[]).every(
      (k) => op[k] === next[k]
    );
    if (!opMatches) return [false, undefined];

    return [true, next["data"]];
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
        setPendingOp,
      }: {
        /**
         * Use this to submit the next operation for the step function to
         * Inngest.
         *
         * If the `fn` containing this parameter isn't defined, the entire
         * function will default to just running this `submitOp` tool, so if
         * that's all you're doing then you might not need to define this.
         */
        submitOp: (opExtras?: Pick<Op, "data" | "opts">) => void;

        /**
         * Use this to pass a promise as the data of the created op. This is
         * useful for tools that are responsible for creating their own data
         * (e.g. steps themselves) and need to wait for that data to be
         * available before submitting the op.
         */
        setPendingOp: (pendingOp: Promise<any>) => void;
      },
      ...args: Parameters<T>
    ) => any
  ): T => {
    return ((...args: Parameters<T>) => {
      if (!active) {
        throw new StepFlowInterrupt();
      }

      const opId = matchOp(...args);

      const [found, data] = getNextPastOpData(opId);

      if (found) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return data;
      }

      active = false;

      const submitOp: Parameters<
        NonNullable<Parameters<typeof createTool>[1]>
      >[0]["submitOp"] = (opExtras) => {
        state.nextOp = { ...opId, ...opExtras };
      };

      const setPendingOp: Parameters<
        NonNullable<Parameters<typeof createTool>[1]>
      >[0]["setPendingOp"] = (pendingOp) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        state.nextOp = pendingOp.then((data) => ({ ...opId, data }));
      };

      /**
       * If we've been passed a custom function to run in response to user data,
       * run that now. That function will then be responsible for submitting an
       * op.
       *
       * If we haven't been given this, simply submit the op.
       */
      if (fn) {
        fn({ submitOp, setPendingOp }, ...args);
      } else {
        submitOp();
      }

      throw new StepFlowInterrupt();
    }) as T;
  };

  const state: {
    nextOp: Op | Promise<Op> | undefined;
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
      <
        IncomingEvent extends keyof Events,
        Opts extends WaitForEventOpts<
          Events[TriggeringEvent],
          Events[IncomingEvent]
        >
      >(
        event: IncomingEvent,
        opts?: Opts
      ) => Opts["timeout"] extends string
        ? Opts["timeout"] extends ""
          ? Events[IncomingEvent]
          : Events[IncomingEvent] | null
        : Events[IncomingEvent]
    >(
      (
        /**
         * The event name to wait for.
         */
        event,

        /**
         * Options to control the event we're waiting for.
         */
        opts
      ) => {
        const matchOpts: { ttl?: string; match?: string } = {};

        if (opts?.timeout) {
          matchOpts.ttl =
            typeof opts.timeout === "string"
              ? opts.timeout
              : dateToTimeStr(opts.timeout);
        }

        if (opts?.match) {
          if (typeof opts.match === "string") {
            matchOpts.match = `event.${opts.match} == async.${opts.match}`;
          } else {
            matchOpts.match = `async.${opts.match[0]} == ${
              typeof opts.match[1] === "string"
                ? `'${opts.match[1]}'`
                : // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                  `${opts.match[1]}`
            }`;
          }
        } else if (opts?.if) {
          matchOpts.match = opts.if;
        }

        return {
          op: StepOpCode.WaitForEvent,
          id: event as string,
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
      ) => T extends (...args: any[]) => Promise<infer U>
        ? Awaited<U extends void ? null : U>
        : ReturnType<T> extends void
        ? null
        : ReturnType<T>
    >(
      (name) => {
        return {
          op: StepOpCode.RunStep,
          id: name,
        };
      },
      ({ setPendingOp }, _name, fn) => {
        setPendingOp(new Promise((resolve) => resolve(fn())));
      }
    ),

    /**
     * Wait a specified amount of time before continuing, in the format of a
     * time string like `"1h30m"` or `"1d"`.
     *
     * To wait until a particular date, use `sleepUntil` instead.
     */
    sleep: createTool<
      (
        /**
         * The amount of time to wait before continuing.
         */
        time: Exclude<TimeStr, "">
      ) => void
    >((time) => {
      return {
        op: StepOpCode.Sleep,
        id: time,
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
      ) => void
    >((time) => {
      return {
        op: StepOpCode.Sleep,
        id: dateToTimeStr(time),
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
   * If provided, the step function will wait for the event for a maximum of
   * this time, at which point the event will be returned as `null` instead of
   * any event data.
   *
   * The time to wait can be specified using a string in the format of
   * `[number][unit]`, e.g. `50ms` for 50 milliseconds, `1s` for 1 second, `2m`
   * for 2 minutes, `3h` for 3 hours, `4d` for 4 days, and `5w` for 5 weeks.
   * These can also be combined, e.g. `1h30m` for 1 hour and 30 minutes.
   *
   * Alternatively, the timeout can be provided as a `Date`, in which case the
   * SDK will calculate the time to wait for you.
   *
   * If this is not specified or is blank (an empty string `""`), the step will
   * wait for the event indefinitely.
   */
  timeout?: TimeStr | Date;

  /**
   * If provided, the step function will wait for the incoming event to match
   * particular criteria. If the event does not match, it will be ignored and
   * the step function will wait for another event.
   *
   * It can either be a string of a dot-notation field name within both events
   * to compare, e.g. `"date.id"` or `"user.email"`, or an array of two values,
   * the first being a field name of the incoming event and the second being the
   * value to compare it to.
   *
   * ```
   * // Wait for an event where the `user.email` field matches
   * match: "user.email"
   *
   * // Wait for an event wher `data.name` matches "Alice"
   * match: ["data.name", "Alice"]
   * ```
   *
   * All of these are helpers for the `if` option, which allows you to specify
   * a custom condition to check. This can be useful if you need to compare
   * multiple fields or use a more complex condition.
   */
  match?:
    | (ObjectPaths<TriggeringEvent> & ObjectPaths<IncomingEvent>)
    | [ObjectPaths<IncomingEvent>, Primitive];

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
