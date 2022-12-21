import { sha1 } from "hash.js";
import sigmund from "sigmund";
import { timeStr } from "../helpers/strings";
import type { ObjectPaths } from "../helpers/types";
import { EventPayload, HashedOp, Op, StepOpCode } from "../types";

/**
 * A unique class used to interrupt the flow of a step. It is intended to be
 * thrown and caught using `instanceof StepFlowExpired`.
 */
export class StepFlowExpired {}

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
>() => {
  // >(
  //   _opStack: OpStack
  // ) => {
  /**
   * We use pos to ensure that hashes are unique for each step and a function
   * will produce the same IDs and outputs every time.
   *
   * Each time attempt to fetch data for an operation, we increment this value
   * and include it in the hash for that op.
   */
  // const pos = 0;

  /**
   * Perform a shallow clone of the opstack to ensure we're not removing
   * elements from the original.
   */
  // const opStack = [..._opStack];

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
   * Returns [true, any] if the next op matches the next past op.
   *
   * Returns [false, undefined] if the next op didn't match or we ran out of
   * stack. In either case, we should run the next op.
   */
  // const getNextPastOpData = (op: HashedOp): IncomingOp | undefined => {
  //   // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  //   return opStack[op.id];
  // };

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
        console.log("tool ran and pushing to state.tickOp");

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
    // return ((...args: Parameters<T>): Promise<any> => {
    //   /**
    //    * Mark that we've used a step function tool, so that we can know
    //    * externally that this isn't a single-step function.
    //    */
    //   state.hasUsedTools = true;

    //   const unhashedOpId: Op = matchOp(...args);
    //   const opId: HashedOp = {
    //     ...unhashedOpId,
    //     id: hashOp(unhashedOpId, pos++),
    //   };

    //   const op = getNextPastOpData(opId);

    //   /**
    //    * If we've never seen this operation before, go tell Inngest it's next.
    //    */
    //   if (!op) {
    //     state.nextOps.push(
    //       Promise.resolve({
    //         ...opId,
    //         ...(fn ? { run: true } : {}),
    //       })
    //     );

    //     return createFrozenPromise();
    //   }

    //   /**
    //    * We now know that this is an operation Inngest knows about and we're
    //    * refilling state.
    //    *
    //    * If we don't have any user-defined code to run or - regardless - if we
    //    * already have data, return that.
    //    */
    //   if (
    //     !fn ||
    //     Object.prototype.hasOwnProperty.call(op, "data") ||
    //     Object.prototype.hasOwnProperty.call(op, "error")
    //   ) {
    //     if (typeof op.data !== "undefined") {
    //       return Promise.resolve(op.data);
    //     }

    //     /**
    //      * If we have an error to throw, try to deserialize it back to an
    //      * actual error object. If this doesn't work, just throw the error as it
    //      * appears.
    //      */
    //     try {
    //       return Promise.reject(deserializeError(op.error as SerializedError));
    //     } catch {
    //       return Promise.reject(op.error);
    //     }
    //   }

    //   /**
    //    * If we do have user-defined code to run, figure out if Inngest wants us
    //    * to run that on this invocation.
    //    *
    //    * If not, return a never-ending Promise that will get garbage-collected
    //    * in the future.
    //    */
    //   if (!op.run) {
    //     return createFrozenPromise();
    //   }

    //   /**
    //    * If Inngest is telling us we do have to run the user-defined code, run
    //    * it and return the result now.
    //    */
    //   state.nextOps.push(
    //     new Promise((resolve) => resolve(fn(...args)))
    //       .then((data) => ({
    //         ...opId,
    //         data: typeof data === "undefined" ? null : data,
    //       }))
    //       .catch((err: Error) => {
    //         /**
    //          * If the user-defined code throws an error, we should return this to
    //          * Inngest as the response for this step. The function didn't fail,
    //          * only this step, so Inngest can decide what we do next.
    //          */
    //         return {
    //           ...opId,
    //           error: serializeError(err),
    //         };
    //       })
    //       .catch((err: Error) => {
    //         /**
    //          * If we can't serialize the error, just return the error directly.
    //          */
    //         return {
    //           ...opId,
    //           error: err,
    //         };
    //       })
    //   );

    //   return createFrozenPromise();
    // }) as T;
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
 *
 * TODO We can't rely on pos for parallel tasks; they may be out of sync.
 *
 * For example, consider a function that specifies for steps: A that leads to B,
 * and C that leads to D:
 *
 * ```
 * await Promise.all([
 *   run("A").then(() => run("B")),
 *   run("C").then(() => run("D")),
 * ]);
 * ```
 *
 * First pass, A and C are returned as steps to run.
 * A is pos 0, and C is pos 1.
 * C resolves.
 * Second pass, D is returned as the step to run.
 * A is pos 0, C is pos 1, and D is pos 2.
 * A resolves.
 * Third pass, B is returned as the step to run.
 * A is pos 0, B is pos 1, C is pos 2, and D is pos 3.
 *
 * This is bad - C and B swap positions due to the promises resolving at
 * different times! We need another value to hash on.
 *
 * An idea is to also include all other previous hashes before this one is
 * executed, but this is exactly the same as pos and results in the same issue.
 *
 * Another option might be to allow ops with the same ID, but to place them all
 * in a positional array. This only mitigates the issue rather than solve it,
 * though.
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
