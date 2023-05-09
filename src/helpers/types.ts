import type { EventPayload } from "../types";

/**
 * Returns a union of all of the values in a given object, regardless of key.
 */
export type ValueOf<T> = T extends Record<string, unknown>
  ? {
      [K in keyof T]: T[K];
    }[keyof T]
  : never;

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
 * Retrieve an event's name based on the given payload. Defaults to `string`.
 */
export type EventName<Event extends EventPayload> = Event extends EventPayload
  ? Event["name"]
  : string;

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
 * Filter out all keys from `T` where the associated value does not match type
 * `U`.
 */
export type KeysNotOfType<T, U> = {
  [P in keyof T]: T[P] extends U ? never : P;
}[keyof T];

/**
 * Returns all keys from objects in the union `T`.
 */
type UnionKeys<T> = T extends T ? keyof T : never;

/**
 * Enforces strict union comformity by ensuring that all potential keys in a
 * union of objects are accounted for in every object.
 *
 * Requires two generics to be used, so is abstracted by {@link StrictUnion}.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StrictUnionHelper<T, TAll> = T extends any
  ? T & Partial<Record<Exclude<UnionKeys<TAll>, keyof T>, never>>
  : never;

/**
 * Enforces strict union comformity by ensuring that all potential keys in a
 * union of objects are accounted for in every object.
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
 */
export type IsStringLiteral<T extends string> = string extends T ? false : true;

/**
 * Returns `true` if the given generic `T` is `any`, or `false` if it is not.
 */
export type IsAny<T> = 0 extends 1 & T ? true : false;
