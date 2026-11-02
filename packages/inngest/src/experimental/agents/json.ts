/**
 * @module
 * The JSON types the agents API shares: `Json` for every value that is text
 * or JSON, and `JsonSchema` for a JSON Schema document.
 */

/**
 * Anything JSON can carry: text, a number, a boolean, `null`, a list of
 * these, or an object of these. `undefined`, functions, `Date` and class
 * instances are not `Json`.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/**
 * A JSON Schema document. It is JSON that comes from outside.
 */
export type JsonSchema = { [key: string]: Json };
