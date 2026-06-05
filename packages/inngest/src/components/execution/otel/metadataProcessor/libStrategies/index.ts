import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { AIMetadataValues } from "../metadata.ts";
import { aiSdkStrategy } from "./aiSdk.ts";
import { genAISemconvStrategy } from "./genAISemconv.ts";
import type { AIMetadataStrategy } from "./types.ts";

const strategies: AIMetadataStrategy[] = [aiSdkStrategy, genAISemconvStrategy];

export const extractAIMetadata = (span: ReadableSpan): AIMetadataValues => {
  for (const strategy of strategies) {
    if (!strategy.matches(span)) {
      continue;
    }

    const values = strategy.extract(span);
    if (Object.keys(values).length > 0) {
      return values;
    }
  }

  return {};
};
