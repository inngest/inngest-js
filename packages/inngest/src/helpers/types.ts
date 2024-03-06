import { type IsEqual } from "type-plus";
import { type EventPayload } from "../types";

/**
 * Returns the given generic as either itself or an array of itself.
 */
export type SingleOrArray<T> = T | T[];

/**
 * Given type `T`, return it as an array if it is not already an array.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AsArray<T> = T extends any[] ? T : [T];

/**
 * Given type `T`, return a tuple of `T` that contains at least one element.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AsTuple<T> = T extends any ? [T, ...T[]] : never;

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
      [K in keyof WithoutInternal<Events>]: PartialK<
        Omit<WithoutInternal<Events>[K], "v">,
        "ts"
      >;
    }[keyof WithoutInternal<Events>]
  >;

/**
 * @public
 */
export type WithoutInternal<T extends Record<string, EventPayload>> = {
  [K in keyof T as K extends `inngest/${string}` ? never : K]: T[K];
};

/**
 * A list of simple, JSON-compatible, primitive types that contain no other
 * values.
 */
export type Primitive =
  | null
  | undefined
  | string
  | number
  | boolean
  | symbol
  | bigint;

/**
 * Returns `true` if `T` is a tuple, else `false`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IsTuple<T extends ReadonlyArray<any>> = number extends T["length"]
  ? false
  : true;

/**
 * Given a tuple `T`, return the keys of that tuple, excluding any shared or
 * generic keys like `number` and standard array methods.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TupleKeys<T extends ReadonlyArray<any>> = Exclude<keyof T, keyof any[]>;

/**
 * Returns `true` if `T1` matches anything in the union `T2`, else` never`.
 */
type AnyIsEqual<T1, T2> = T1 extends T2
  ? IsEqual<T1, T2> extends true
    ? true
    : never
  : never;

/**
 * A helper for concatenating an existing path `K` with new paths from the
 * value `V`, making sure to skip those we've already seen in
 * `TraversedTypes`.
 *
 * Purposefully skips some primitive objects to avoid building unsupported or
 * recursive paths.
 */
type PathImpl<K extends string | number, V, TraversedTypes> = V extends
  | Primitive
  | Date
  ? `${K}`
  : true extends AnyIsEqual<TraversedTypes, V>
    ? `${K}`
    : `${K}` | `${K}.${PathInternal<V, TraversedTypes | V>}`;

/**
 * Start iterating over a given object `T` and return all string paths used to
 * access properties within that object as if you were in code.
 */
type PathInternal<T, TraversedTypes = T> = T extends ReadonlyArray<infer V>
  ? IsTuple<T> extends true
    ? {
        [K in TupleKeys<T>]-?: PathImpl<K & string, T[K], TraversedTypes>;
      }[TupleKeys<T>]
    : PathImpl<number, V, TraversedTypes>
  : {
      [K in keyof T]-?: PathImpl<K & string, T[K], TraversedTypes>;
    }[keyof T];

/**
 * Given an object, recursively return all string paths used to access
 * properties within that object as if you were in code.
 *
 * This is an exported helper method to ensure we only try to access object
 * paths of known objects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ObjectPaths<T> = T extends any ? PathInternal<T> : never;

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
  ...infer TRest,
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

/**
 * Given an object `T`, return `true` if it contains no keys, or `false` if it
 * contains any keys.
 *
 * Useful for detecting the passing of a `{}` (any non-nullish) type.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type IsEmptyObject<T> = {} extends T
  ? // eslint-disable-next-line @typescript-eslint/ban-types
    T extends {}
    ? true
    : false
  : false;

/**
 * Create a tuple that can be of length 1 to `TLength`, where each element is
 * of type `TElement`.
 */
export type RecursiveTuple<
  TElement,
  TLength extends number,
  TAccumulator extends TElement[] = [TElement],
> = TAccumulator["length"] extends TLength
  ? TAccumulator
  :
      | RecursiveTuple<TElement, TLength, [TElement, ...TAccumulator]>
      | TAccumulator;

// eslint-disable-next-line @typescript-eslint/ban-types
export type Simplify<T> = { [KeyType in keyof T]: T[KeyType] } & {};

export type ConditionalSimplifyDeep<
  Type,
  ExcludeType = never,
  IncludeType = unknown,
> = Type extends ExcludeType
  ? Type
  : Type extends IncludeType
    ? {
        [TypeKey in keyof Type]: ConditionalSimplifyDeep<
          Type[TypeKey],
          ExcludeType,
          IncludeType
        >;
      }
    : Type;

export type SimplifyDeep<Type> = ConditionalSimplifyDeep<
  Type,
  // eslint-disable-next-line @typescript-eslint/ban-types
  Function | Iterable<unknown>,
  object
>;

/**
Returns a boolean for whether the given type is `null`.
*/
export type IsNull<T> = [T] extends [null] ? true : false;

/**
Returns a boolean for whether the given type is `unknown`.

{@link https://github.com/dsherret/conditional-type-checks/pull/16}

Useful in type utilities, such as when dealing with unknown data from API calls.

@example
```
import type {IsUnknown} from 'type-fest';

// https://github.com/pajecawav/tiny-global-store/blob/master/src/index.ts
type Action<TState, TPayload = void> =
	IsUnknown<TPayload> extends true
		? (state: TState) => TState,
		: (state: TState, payload: TPayload) => TState;

class Store<TState> {
	constructor(private state: TState) {}

	execute<TPayload = void>(action: Action<TState, TPayload>, payload?: TPayload): TState {
		this.state = action(this.state, payload);
		return this.state;
	}

	// ... other methods
}

const store = new Store({value: 1});
declare const someExternalData: unknown;

store.execute(state => ({value: state.value + 1}));
//=> `TPayload` is `void`

store.execute((state, payload) => ({value: state.value + payload}), 5);
//=> `TPayload` is `5`

store.execute((state, payload) => ({value: state.value + payload}), someExternalData);
//=> Errors: `action` is `(state: TState) => TState`
```
*/
export type IsUnknown<T> = unknown extends T // `T` can be `unknown` or `any`
  ? IsNull<T> extends false // `any` can be `null`, but `unknown` can't be
    ? true
    : false
  : false;
