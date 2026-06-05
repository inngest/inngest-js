import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

export const firstFiniteNumber = (
  span: ReadableSpan,
  keys: string[],
): number | undefined => {
  for (const key of keys) {
    const value = span.attributes[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
};

export const firstNonEmptyString = (
  span: ReadableSpan,
  keys: string[],
): string | undefined => {
  for (const key of keys) {
    const value = span.attributes[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }

  return undefined;
};
