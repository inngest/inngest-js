/**
 * Returns a union of all of the values in a given object, regardless of key.
 */
export type ValueOf<T> = T extends Record<string, any>
  ? {
      [K in keyof T]: T[K];
    }[keyof T]
  : never;

/**
 * Returns the given generic as either itself or an array of itself.
 */
export type SingleOrArray<T> = T | T[];
