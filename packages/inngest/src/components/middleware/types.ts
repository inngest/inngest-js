/**
 * Turn into an "open string union". This is a string union that allows for
 * additional strings to be added to the union. This means adding a new union
 * member won't be a breaking change, but it'll still include autocompletion for
 * the union members
 */
export type OpenStringUnion<T> = T | (string & {});

/**
 * Extract string literal types from a union, filtering out `string` and
 * `string & {}`
 */
export type ExtractLiteralStrings<T> = T extends string & {}
  ? T extends `${infer _}`
    ? T
    : never
  : never;
