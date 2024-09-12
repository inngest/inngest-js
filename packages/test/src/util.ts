import { internalEvents } from "inngest";
import type { Context, EventPayload } from "inngest/types";
import { ulid } from "ulid";

/**
 * The default context transformation function that mocks all step tools. Use
 * this in addition to your custom transformation function if you'd like to keep
 * this functionality.
 */
export const mockCtx = (ctx: Readonly<Context.Any>): Context.Any => {
  // const step = Object.keys(ctx.step).reduce(
  //   (acc, key) => {
  //     const tool = ctx.step[key as keyof typeof ctx.step];
  //     // const mock = mockFn(tool);

  //     class FunctionWrapper extends Function {
  //       constructor(...args: any[]) {
  //         return mockFn(tool).apply(this, args);
  //       }
  //     }

  //     const mock = FunctionWrapper;
  //     // const mock2 = jest.fn(tool);

  //     return {
  //       ...acc,
  //       [key]: mock,
  //     };
  //   },
  //   {} as Context.Any["step"]
  // );

  // return {
  //   ...ctx,
  //   step,
  // };
  return ctx;
};

/**
 * Creates a tiny mock invocation event used to replace or complement given
 * event data.
 */
export const createMockEvent = () => {
  return {
    id: ulid(),
    name: `${internalEvents.FunctionInvoked}`,
    data: {},
    ts: Date.now(),
  } satisfies EventPayload;
};

/**
 * A deep partial, where every key of every object is optional.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Ensures that all keys in the subset are present in the actual object and that
 * the values match.
 */
export const isDeeplyEqual = <T extends object>(
  subset: DeepPartial<T>,
  actual: T
): boolean => {
  return Object.keys(subset).every((key) => {
    const subsetValue = subset[key as keyof T];
    const actualValue = actual[key as keyof T];

    if (
      typeof subsetValue === "object" &&
      subsetValue !== null &&
      typeof actualValue === "object" &&
      actualValue !== null
    ) {
      return isDeeplyEqual(subsetValue, actualValue);
    }

    return subsetValue === actualValue;
  });
};
