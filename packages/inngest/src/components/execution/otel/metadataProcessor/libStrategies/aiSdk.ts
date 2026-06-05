import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { type AIMetadataValues, aiMetadataKeys } from "../metadata.ts";
import { firstFiniteNumber, firstNonEmptyString } from "./helpers.ts";
import type { AIMetadataStrategy } from "./types.ts";

const aiAttributes = {
  inputTokens: "ai.usage.inputTokens",
  operationId: "ai.operationId",
  operationName: "operation.name",
  outputTokens: "ai.usage.outputTokens",
  modelId: "ai.model.id",
} as const;

export const aiSdkStrategy: AIMetadataStrategy = {
  name: "ai-sdk",
  matches(span) {
    return isTopLevelAISpan(span);
  },
  extract(span) {
    const values: AIMetadataValues = {};

    const inputTokens = firstFiniteNumber(span, [aiAttributes.inputTokens]);
    if (inputTokens !== undefined) {
      values[aiMetadataKeys.inputTokens] = inputTokens;
    }

    const outputTokens = firstFiniteNumber(span, [aiAttributes.outputTokens]);
    if (outputTokens !== undefined) {
      values[aiMetadataKeys.outputTokens] = outputTokens;
    }

    const modelId = firstNonEmptyString(span, [aiAttributes.modelId]);
    if (modelId !== undefined) {
      values[aiMetadataKeys.model] = modelId;
    }

    return values;
  },
};

const isTopLevelAISpan = (span: ReadableSpan): boolean => {
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
};
