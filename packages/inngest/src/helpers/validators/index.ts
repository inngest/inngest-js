import type { IsUnknown } from "../types.ts";
import type * as z from "./zod";

/**
 * Given an input value, infer the output type.
 *
 * This is a helper type to infer the output type of schemas, ensuring we can
 * support many validation libraries here without having to write custom
 * validators for each.
 *
 * @public
 */
export type ResolveSchema<
  TInput,
  TFallback = TInput,
  TUnknownFallback = TFallback,
> = IsUnknown<TInput> extends true
  ? TUnknownFallback
  : TInput extends z.ZodTypeAny
    ? z.ZodInfer<TInput>
    : TFallback;

/**
 * A valid input schema for an event's `data`.
 *
 * @public
 */
export type ValidSchemaInput = z.ValidZodValue;

/**
 * A valid output schema.
 *
 * @public
 */
export type ValidSchemaOutput = z.ZodTypeAny;
