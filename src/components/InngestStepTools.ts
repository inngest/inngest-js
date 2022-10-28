import { createInfiniteProxy } from "../helpers/proxy";
import { EventPayload, StepOpCode } from "../types";

export type Op = [op: StepOpCode, id: string, data: any];
export type OpId = [op: StepOpCode, id: string];
export type OpStack = Op[];
export type SubmitOpFn = (op: OpId | Op) => void;

/**
 * This feels better being a class, but class bindings are lost (i.e. `this`
 * becomes `undefined`) if a user destructures the tools within their step
 * function.
 *
 * Thus, we must instead use closures for this functionality.
 */
export const createStepTools = <Events extends Record<string, EventPayload>>(
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
    op: OpId
  ): [found: false, data: undefined] | [found: true, data: any] => {
    const next = opStack.shift();

    /**
     * If we had no next op, return fail case.
     */
    if (!next) return [false, undefined];

    /**
     * Check if op matches, returning fail case if it doesn't.
     */
    for (let i = 0; i < op.length; i++) {
      if (op[i] !== next[i]) return [false, undefined];
    }

    return [true, next[2]];
  };

  const createTool = <T extends (...args: any[]) => any>(
    fn: (
      {
        submitOp,
        setPendingOp,
      }: {
        submitOp: (...args: [] | [data: any]) => void;
        setPendingOp: (pendingOp: Promise<any>) => void;
      },
      ...args: Parameters<T>
    ) => any,
    matchOp: (...args: Parameters<T>) => OpId
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

      const submitOp = (...args: [] | [data: any]) => {
        if (args.length) {
          _submitOp([...opId, data]);
        } else {
          _submitOp([...opId]);
        }
      };

      const setPendingOp = (pendingOp: Promise<any>) => {
        _mutableState.pendingOp = pendingOp.then((data) => [...opId, data]);
      };

      fn({ submitOp, setPendingOp }, ...args);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return createInfiniteProxy();
    }) as T;
  };

  return {
    waitForEvent: createTool<
      <Event extends keyof Events>(event: Event) => Events[Event]
    >(
      ({ submitOp }) => {
        submitOp();
      },
      (event) => {
        return [StepOpCode.WaitForEvent, event as string];
      }
    ),

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
      ({ setPendingOp }, _name, fn) => {
        setPendingOp(new Promise((resolve) => resolve(fn())));
      },
      (name) => {
        return [StepOpCode.RunStep, name];
      }
    ),
  };
};
