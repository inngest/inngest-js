import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { type AIMetadataValues, aiMetadataKeys } from "../metadata.ts";
import { firstFiniteNumber, firstNonEmptyString } from "./helpers.ts";
import type { AIMetadataStrategy } from "./types.ts";

const genAIAttributes = {
  completionTokens: "gen_ai.usage.completion_tokens",
  inputTokens: "gen_ai.usage.input_tokens",
  operationName: "gen_ai.operation.name",
  outputTokens: "gen_ai.usage.output_tokens",
  promptTokens: "gen_ai.usage.prompt_tokens",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  system: "gen_ai.system",
} as const;

export const genAISemconvStrategy: AIMetadataStrategy = {
  name: "gen-ai-semconv",
  matches(span) {
    return isGenAISemanticConventionSpan(span);
  },
  extract(span) {
    const values: AIMetadataValues = {};

    const inputTokens = firstFiniteNumber(span, [
      genAIAttributes.inputTokens,
      genAIAttributes.promptTokens,
    ]);
    if (inputTokens !== undefined) {
      values[aiMetadataKeys.inputTokens] = inputTokens;
    }

    const outputTokens = firstFiniteNumber(span, [
      genAIAttributes.outputTokens,
      genAIAttributes.completionTokens,
    ]);
    if (outputTokens !== undefined) {
      values[aiMetadataKeys.outputTokens] = outputTokens;
    }

    const modelId = firstNonEmptyString(span, [
      genAIAttributes.responseModel,
      genAIAttributes.requestModel,
    ]);
    if (modelId !== undefined) {
      values[aiMetadataKeys.model] = modelId;
    }

    return values;
  },
};

const isGenAISemanticConventionSpan = (span: ReadableSpan): boolean => {
  const system = span.attributes[genAIAttributes.system];
  const operationName = span.attributes[genAIAttributes.operationName];

  return (
    typeof system === "string" &&
    system.length > 0 &&
    typeof operationName === "string" &&
    operationName.length > 0
  );
};
