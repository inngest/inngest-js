import { Context, EventPayload, internalEvents } from "inngest";
import { ulid } from "ulid";
import { mockAny } from "./spy.js";

/**
 * The default context transformation function that mocks all step tools. Use
 * this in addition to your custom transformation function if you'd like to keep
 * this functionality.
 */
export const mockCtx = (ctx: Readonly<Context.Any>): Context.Any => {
  return {
    ...ctx,
    step: mockAny(ctx.step),
  };
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

    // an array? find all of the values
    if (Array.isArray(subsetValue) && Array.isArray(actualValue)) {
      return subsetValue.every((subValue, i) => {
        return isDeeplyEqual(subValue, actualValue[i]);
      });
    }

    // a non-array object?
    if (
      typeof subsetValue === "object" &&
      subsetValue !== null &&
      typeof actualValue === "object" &&
      actualValue !== null
    ) {
      return isDeeplyEqual(subsetValue as T, actualValue);
    }

    // anything else
    return subsetValue === actualValue;
  });
};

type DeferredPromiseReturn<T> = {
  promise: Promise<T>;
  resolve: (value: T) => DeferredPromiseReturn<T>;
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  reject: (reason: any) => DeferredPromiseReturn<T>;
};

/**
 * Creates and returns Promise that can be resolved or rejected with the
 * returned `resolve` and `reject` functions.
 *
 * Resolving or rejecting the function will return a new set of Promise control
 * functions. These can be ignored if the original Promise is all that's needed.
 */
export const createDeferredPromise = <T>(): DeferredPromiseReturn<T> => {
  let resolve: DeferredPromiseReturn<T>["resolve"];
  let reject: DeferredPromiseReturn<T>["reject"];

  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = (value: T) => {
      _resolve(value);
      return createDeferredPromise<T>();
    };

    reject = (reason) => {
      _reject(reason);
      return createDeferredPromise<T>();
    };
  });

  return { promise, resolve: resolve!, reject: reject! };
};
