import { createInfiniteProxy } from "../helpers/proxy";
import { ObjectPaths, Primitive } from "../helpers/types";
import { EventPayload, StepOpCode } from "../types";

export type Op = {
  op: StepOpCode;
  id: string;
  opts?: any;
  data?: any;
};

export type OpStack = Op[];
export type SubmitOpFn = (op: Op) => void;

/**
 * This feels better being a class, but class bindings are lost (i.e. `this`
 * becomes `undefined`) if a user destructures the tools within their step
 * function.
 *
 * Thus, we must instead use closures for this functionality.
 */
export const createStepTools = <
  Events extends Record<string, EventPayload>,
  TriggeringEvent extends keyof Events
>(
  _opStack: OpStack,
  _submitOp: SubmitOpFn,
  _mutableState: {
    /**
     * An asynchronous step that is still running, even through the synchronous
     * step flow function is complete.
     */
    pendingOp: Promise<Op> | undefined;
  }
) => {
  /**
   * Controls whether these toolsets are active or not. Exposed tools should
   * watch this value to decide what action to perform. It is most likely that
   * if this boolean is `false` then they should immediately return an infinite
   * proxy.
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

  const createTool = <T extends (...args: any[]) => any>(
    matchOp: (...args: Parameters<T>) => Op,
    fn?: (
      {
        submitOp,
        setPendingOp,
      }: {
        submitOp: (opExtras?: Pick<Op, "data" | "opts">) => void;
        setPendingOp: (pendingOp: Promise<any>) => void;
      },
      ...args: Parameters<T>
    ) => any
  ): T => {
    return ((...args: Parameters<T>) => {
      if (!active) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return createInfiniteProxy();
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
        _submitOp({ ...opId, ...opExtras });
      };

      const setPendingOp: Parameters<
        NonNullable<Parameters<typeof createTool>[1]>
      >[0]["setPendingOp"] = (pendingOp) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        _mutableState.pendingOp = pendingOp.then((data) => ({ ...opId, data }));
      };

      if (fn) {
        fn({ submitOp, setPendingOp }, ...args);
      } else {
        submitOp();
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return createInfiniteProxy();
    }) as T;
  };

  /**
   * Define the set of tools the user has access to for their step functions.
   *
   * Each key is the function name and is expected to run `createTool` and pass
   * a generic type for that function as it will appear in the user's code.
   */
  return {
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
    >((event, opts) => {
      const matchOpts: { ttl?: string; match?: string } = {};

      if (opts?.timeout) {
        matchOpts.ttl = opts.timeout;
      }

      if (opts?.match) {
        if (opts.match.length === 1) {
          opts.if = `event.${opts.match[0]} == async.${opts.match[0]}`;
        } else {
          opts.if = `async.${opts.match[0]} == ${
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
        opts,
      };
    }),

    step: createTool<
      <T extends (...args: any[]) => any>(
        name: string,
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
  };
};

type TimeStr = `${`${number}w` | ""}${`${number}d` | ""}${`${number}h` | ""}${
  | `${number}m`
  | ""}${`${number}s` | ""}${`${number}ms` | ""}`;

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
   * The time to wait is specified using a string in the format of
   * `[number][unit]`, e.g. `50ms` for 50 milliseconds, `1s` for 1 second, `2m`
   * for 2 minutes, `3h` for 3 hours, `4d` for 4 days, and `5w` for 5 weeks.
   *
   * Times can also be combined, e.g. `1h30m` for 1 hour and 30 minutes.
   *
   * If this is not specified or is blank (an empty string `""`), the step will
   * wait for the event indefinitely.
   */
  timeout?: TimeStr;

  match?:
    | [ObjectPaths<TriggeringEvent> & ObjectPaths<IncomingEvent>]
    | [ObjectPaths<IncomingEvent>, Primitive];

  if?: string;
}
