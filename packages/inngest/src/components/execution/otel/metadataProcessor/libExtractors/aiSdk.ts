import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { extractMetadataValues } from "./helpers.ts";
import type { AIMetadataExtractor } from "./types.ts";

const aiAttributes = {
  inputTokens: "ai.usage.inputTokens",
  operationId: "ai.operationId",
  operationName: "operation.name",
  outputTokens: "ai.usage.outputTokens",
  modelId: "ai.model.id",
} as const;

export const aiSdkExtractor: AIMetadataExtractor = {
  name: "ai-sdk",
  matches(span) {
    return isTopLevelAISpan(span);
  },
  extract(span) {
    return extractMetadataValues(span, {
      inputTokens: [aiAttributes.inputTokens],
      model: [aiAttributes.modelId],
      outputTokens: [aiAttributes.outputTokens],
    });
  },
};

function isTopLevelAISpan(span: ReadableSpan): boolean {
  if (span.instrumentationScope.name !== "ai") {
    return false;
  }

  const operationName = span.attributes[aiAttributes.operationName];
  const operationId = span.attributes[aiAttributes.operationId];

  if (
    typeof operationName === "string" &&
    typeof operationId === "string" &&
    operationName !== operationId
  ) {
    return false;
  }

  let spanOperation = span.name;
  if (typeof operationName === "string") {
    spanOperation = operationName;
  } else if (typeof operationId === "string") {
    spanOperation = operationId;
  }

  if (!spanOperation.startsWith("ai.")) {
    return false;
  }

  return !spanOperation.slice("ai.".length).includes(".");
}
