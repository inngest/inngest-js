import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { AIMetadataValues } from "../metadata.ts";

export type AIMetadataStrategy = {
  name: string;
  matches(span: ReadableSpan): boolean;
  extract(span: ReadableSpan): AIMetadataValues;
};
