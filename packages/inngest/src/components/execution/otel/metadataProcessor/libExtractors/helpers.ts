import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { type AIMetadataValues, aiMetadataKeys } from "../metadata.ts";

export function extractMetadataValues(
  span: ReadableSpan,
  keys: {
    inputTokens: string[];
    model: string[];
    outputTokens: string[];
  },
): AIMetadataValues {
  const values: AIMetadataValues = {};

  const inputTokens = firstFiniteNumber(span, keys.inputTokens);
  if (inputTokens !== undefined) {
    values[aiMetadataKeys.inputTokens] = inputTokens;
  }

  const outputTokens = firstFiniteNumber(span, keys.outputTokens);
  if (outputTokens !== undefined) {
    values[aiMetadataKeys.outputTokens] = outputTokens;
  }

  const model = firstNonEmptyString(span, keys.model);
  if (model !== undefined) {
    values[aiMetadataKeys.model] = model;
  }

  return values;
}

export function firstFiniteNumber(
  span: ReadableSpan,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = span.attributes[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

export function firstNonEmptyString(
  span: ReadableSpan,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = span.attributes[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }

  return undefined;
}
