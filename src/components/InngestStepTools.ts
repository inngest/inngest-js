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
  mutableState: {
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

  const submitOp = (...args: Parameters<SubmitOpFn>) => {
    /**
     * In the future, we can use `setImmediate()` to only set this property once
     * the event loop has ticked over.
     *
     * This results in us being able to collect all promises for a step function
     * in order to appropriately trigger parallel actions such as multiple steps
     * or multiple waits.
     */
    active = false;

    _submitOp(...args);
  };

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

  return {
    waitForEvent: <Event extends keyof Events>(event: Event): Events[Event] => {
      if (!active) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return createInfiniteProxy();
      }

      const [found, data] = getNextPastOpData([
        StepOpCode.WaitForEvent,
        event as string,
      ]);

      if (found) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return data;
      }

      submitOp([StepOpCode.WaitForEvent, event as string]);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return createInfiniteProxy();
    },

    step<T extends (...args: any[]) => any>(
      name: string,
      fn: T
    ): T extends (...args: any[]) => Promise<infer U>
      ? Awaited<U extends void ? null : U>
      : ReturnType<T> extends void
      ? null
      : ReturnType<T> {
      if (!active) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return createInfiniteProxy();
      }

      const [found, data] = getNextPastOpData([StepOpCode.RunStep, name]);

      if (found) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return data;
      }

      /**
       * Wrap the given function in a promise to always promisify it. This allows
       * us to handle potentially async steps but still return synchronously
       * mid-flow.
       */
      active = false;

      mutableState.pendingOp = new Promise((resolve) => resolve(fn())).then(
        (ret) => {
          console.log("fn() resolved with:", ret);
          return [StepOpCode.RunStep, name, ret];
        }
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return createInfiniteProxy();
    },
  };
};

class InngestStepTools<Events extends Record<string, EventPayload>> {
  /**
   * Controls whether these toolsets are active or not. Exposed tools should
   * watch this value to decide what action to perform. It is most likely that
   * if this boolean is `false` then they should immediately return an infinite
   * proxy.
   */
  private active = true;

  private _submitOp: SubmitOpFn;
  private opStack: OpStack;

  /**
   * An asynchronous step that is still running, even through the synchronous
   * step flow function is complete.
   */
  private pendingOp: Promise<Op> | undefined;

  constructor(opStack: OpStack, submitOp: SubmitOpFn) {
    this._submitOp = submitOp;
    this.opStack = opStack;
  }

  private submitOp(...args: Parameters<SubmitOpFn>) {
    /**
     * In the future, we can use `setImmediate()` to only set this property once
     * the event loop has ticked over.
     *
     * This results in us being able to collect all promises for a step function
     * in order to appropriately trigger parallel actions such as multiple steps
     * or multiple waits.
     */
    this.active = false;

    this._submitOp(...args);
  }

  /**
   * Returns [true, any] if the next op matches the next past op.
   *
   * Returns [false, undefined] if the next op didn't match or we ran out of
   * stack. In either case, we should run the next op.
   */
  private getNextPastOpData(
    op: OpId
  ): [found: false, data: undefined] | [found: true, data: any] {
    const next = this.opStack.shift();

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
  }

  public waitForEvent<Event extends keyof Events>(event: Event): Events[Event] {
    if (!this.active) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return createInfiniteProxy();
    }

    const [found, data] = this.getNextPastOpData([
      StepOpCode.WaitForEvent,
      event as string,
    ]);

    if (found) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return data;
    }

    this.submitOp([StepOpCode.WaitForEvent, event as string]);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return createInfiniteProxy();
  }

  public step<T extends (...args: any[]) => any>(
    name: string,
    fn: T
  ): T extends (...args: any[]) => Promise<infer U>
    ? Awaited<U>
    : ReturnType<T> {
    if (!this.active) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return createInfiniteProxy();
    }

    const [found, data] = this.getNextPastOpData([StepOpCode.RunStep, name]);

    if (found) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return data;
    }

    /**
     * Wrap the given function in a promise to always promisify it. This allows
     * us to handle potentially async steps but still return synchronously
     * mid-flow.
     */
    this.active = false;

    this.pendingOp = new Promise((resolve) => resolve(fn())).then((ret) => {
      console.log("fn() resolved with:", ret);
      return [StepOpCode.RunStep, name, ret];
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return createInfiniteProxy();
  }
}
