import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { AIMetadataValues } from "../metadata.ts";

export type AIMetadataExtractor = {
  name: string;
  matches(span: ReadableSpan): boolean;
  extract(span: ReadableSpan): AIMetadataValues;
};
