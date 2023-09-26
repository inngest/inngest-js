import { type Simplify } from "type-fest";
import { type EventPayload } from "../types";

/**
 * Returns the given generic as either itself or an array of itself.
 */
export type SingleOrArray<T> = T | T[];

/**
 * Returns the given generic as either itself or a promise of itself.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Acts like `Partial<T>` but only for the keys in `K`, leaving the rest alone.
 */
export type PartialK<T, K extends PropertyKey = PropertyKey> = Partial<
  Pick<T, Extract<keyof T, K>>
> &
  Omit<T, K> extends infer O
  ? { [P in keyof O]: O[P] }
  : never;

/**
 * A payload that could be sent to Inngest, based on the given `Events`.
 */
export type SendEventPayload<Events extends Record<string, EventPayload>> =
  SingleOrArray<
    {
      [K in keyof Events]: PartialK<Omit<Events[K], "v">, "ts">;
    }[keyof Events]
  >;

/**
 * A list of simple, JSON-compatible, primitive types that contain no other
 * values.
 */
export type Primitive = string | number | boolean | undefined | null;

/**
 * Given a key and a value, create a string that would be used to access that
 * property in code.
 */
type StringPath<K extends string | number, V> = V extends Primitive
  ? `${K}`
  : `${K}` | `${K}.${Path<V>}`;

/**
 * Given an object or array, recursively return all string paths used to access
 * properties within those objects.
 */
type Path<T> = T extends Array<infer V>
  ? StringPath<number, V>
  : {
      [K in keyof T]-?: StringPath<K & string, T[K]>;
    }[keyof T];

/**
 * Given an object, recursively return all string paths used to access
 * properties within that object as if you were in code.
 *
 * This is an exported helper method to ensure we only try to access object
 * paths of known objects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ObjectPaths<T extends Record<string, any>> = Path<T>;

/**
 * Returns all keys from objects in the union `T`.
 *
 * @public
 */
export type UnionKeys<T> = T extends T ? keyof T : never;

/**
 * Enforces strict union comformity by ensuring that all potential keys in a
 * union of objects are accounted for in every object.
 *
 * Requires two generics to be used, so is abstracted by {@link StrictUnion}.
 *
 * @public
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StrictUnionHelper<T, TAll> = T extends any
  ? T & Partial<Record<Exclude<UnionKeys<TAll>, keyof T>, never>>
  : never;

/**
 * Enforces strict union comformity by ensuring that all potential keys in a
 * union of objects are accounted for in every object.
 *
 * @public
 */
export type StrictUnion<T> = StrictUnionHelper<T, T>;

/**
 * Returns `true` if the given generic `T` is a string literal, e.g. `"foo"`, or
 * `false` if it is a string type, e.g. `string`.
 *
 * Useful for checking whether the keys of an object are known or not.
 *
 * @example
 * ```ts
 * // false
 * type ObjIsGeneric = IsStringLiteral<keyof Record<string, boolean>>;
 *
 * // true
 * type ObjIsKnown = IsStringLiteral<keyof { foo: boolean; }>; // true
 * ```
 *
 * @internal
 */
export type IsStringLiteral<T extends string> = string extends T ? false : true;

/**
 * Returns `true` if the given generic `T` is `any`, or `false` if it is not.
 */
export type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * Given a function T, return the awaited return type of that function,
 * ignoring the fact that T may be undefined.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Await<T extends ((...args: any[]) => any) | undefined> = Awaited<
  ReturnType<NonNullable<T>>
>;

/**
 * Given an object TAcc and an array of objects TArr, return a new object that
 * is the result of merging all of the objects in TArr into TAcc.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type ObjectAssign<TArr, TAcc = {}> = TArr extends [
  infer TFirst,
  ...infer TRest
]
  ? Simplify<ObjectAssign<TRest, Omit<TAcc, keyof TFirst> & TFirst>>
  : TAcc;

/**
 * Make a type's keys mutually exclusive.
 *
 * @example
 * Make 1 key mutually exclusive with 1 other key.
 *
 * ```ts
 * type MyType = ExclusiveKeys<{a: number, b: number}, "a", "b">
 *
 * const valid1: MyType = { a: 1 }
 * const valid2: MyType = { b: 1 }
 * const invalid1: MyType = { a: 1, b: 1 }
 * ```
 *
 * @example
 * Make 1 key mutually exclusive with 2 other keys.
 *
 * ```ts
 * type MyType = ExclusiveKeys<{a: number, b: number, c: number}, "a", "b" | "c">
 *
 * const valid1: MyType = { a: 1 };
 * const valid2: MyType = { b: 1, c: 1 };
 * const invalid1: MyType = { a: 1, b: 1 };
 * const invalid2: MyType = { a: 1, c: 1 };
 * const invalid3: MyType = { a: 1, b: 1, c: 1 };
 * ```
 */
export type ExclusiveKeys<T, Keys1 extends keyof T, Keys2 extends keyof T> =
  | (Omit<T, Keys1> & { [K in Keys1]?: never })
  | (Omit<T, Keys2> & { [K in Keys2]?: never });

/**
 * A type that represents either `A` or `B`. Shared properties retain their
 * types and unique properties are marked as optional.
 */
export type Either<A, B> = Partial<A> & Partial<B> & (A | B);

/**
 * Given a function `T`, return the parameters of that function, except for the
 * first one.
 */
export type ParametersExceptFirst<T> = T extends (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arg0: any,
  ...rest: infer U
) => // eslint-disable-next-line @typescript-eslint/no-explicit-any
any
  ? U
  : never;
