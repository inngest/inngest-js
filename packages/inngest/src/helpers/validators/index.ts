import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { IsUnknown } from "../types.ts";

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
  : TInput extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<TInput>
    : TFallback;

/**
 * A valid input schema for an event's `data`.
 *
 * @public
 */
export type ValidSchemaInput = StandardSchemaV1;

/**
 * A valid output schema.
 *
 * @public
 */
export type ValidSchemaOutput = StandardSchemaV1;
