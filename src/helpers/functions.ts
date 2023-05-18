import { type Await } from "./types";

/**
 * Wraps a function with a cache. When the returned function is run, it will
 * cache the result and return it on subsequent calls.
 */
export const cacheFn = <T extends (...args: unknown[]) => unknown>(
  fn: T
): T => {
  const key = "value";
  const cache = new Map<typeof key, unknown>();

  return ((...args) => {
    if (!cache.has(key)) {
      cache.set(key, fn(...args));
    }

    return cache.get(key);
  }) as T;
};

type AnyFunc = (...arg: any[]) => any;

type PipeArgs<F extends AnyFunc[], Acc extends AnyFunc[] = []> = F extends [
  (...args: infer A) => infer B
]
  ? [...Acc, (...args: A) => B]
  : F extends [(...args: infer A) => any, ...infer Tail]
  ? Tail extends [(arg: infer B) => any, ...any[]]
    ? PipeArgs<Tail, [...Acc, (...args: A) => B]>
    : Acc
  : Acc;

type LastFnReturnType<F extends Array<AnyFunc>, Else = never> = F extends [
  ...any[],
  (...arg: any) => infer R
]
  ? R
  : Else;

function waterfall<FirstFn extends AnyFunc, F extends AnyFunc[]>(
  arg: Parameters<FirstFn>[0],
  firstFn: FirstFn,
  ...fns: PipeArgs<F> extends F ? F : PipeArgs<F>
): LastFnReturnType<F, ReturnType<FirstFn>> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return null as any;
  // return (fns as AnyFunc[]).reduce((acc, fn) => fn(acc), firstFn(arg));
}

const pipe =
  <T>(...fns: Array<(arg: T) => T>) =>
  (value: T) =>
    fns.reduce((acc, fn) => fn(acc), value);

// export const waterfall = async <
//   const T extends any[],
//   const U extends ((...args: T) => any)[]
// >(
//   input: T,
//   fns: U
// ): ObjectAssign<> => {
//   // eslint-disable-next-line @typescript-eslint/no-unsafe-return
//   return null as any;
// };

const f0 = <TFirstFn extends AnyFunc>(
  fn: TFirstFn,
  ...fns: AnyFunc[]
): Promise<Await<TFirstFn>> => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return null as any;
};

const x = f0(
  //      ^?
  (a: number) => `wow: ${a + 1}`,
  (a) => Boolean(a)
  // (a: number) => a + 3
);

const foo = pipe<number>(
  (a) => a + 1,
  (a) => a + 2,
  (a) => a + 3
);

// const { serializeError } = require('serialize-error')

// function waterfall (...fns) {
//   return async function (event) {
//     let result

//     try {
//       for (const fn of fns) {
//         result = await fn(event)

//         if (result !== undefined) {
//           return [null, result]
//         }
//       }

//       return [null, result]
//     } catch (e) {
//       console.error(e)
//       const err = (e instanceof Error) ? serializeError(e) : e

//       return [err, null]
//     }
//   }
// }

// module.exports = waterfall
