import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { AIMetadataValues } from "../metadata.ts";
import { aiSdkExtractor } from "./aiSdk.ts";
import { genAISemconvExtractor } from "./genAISemconv.ts";
import type { AIMetadataExtractor } from "./types.ts";

const extractors: AIMetadataExtractor[] = [
  aiSdkExtractor,
  genAISemconvExtractor,
];

export function extractAIMetadata(span: ReadableSpan): AIMetadataValues {
  for (const extractor of extractors) {
    if (!extractor.matches(span)) {
      continue;
    }

    const values = extractor.extract(span);
    if (Object.keys(values).length > 0) {
      return values;
    }
  }

  return {};
}
