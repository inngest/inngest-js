import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { extractMetadataValues } from "./helpers.ts";
import type { AIMetadataExtractor } from "./types.ts";

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

export const genAISemconvExtractor: AIMetadataExtractor = {
  name: "gen-ai-semconv",
  matches(span) {
    return isGenAISemanticConventionSpan(span);
  },
  extract(span) {
    return extractMetadataValues(span, {
      inputTokens: [genAIAttributes.inputTokens, genAIAttributes.promptTokens],
      model: [genAIAttributes.responseModel, genAIAttributes.requestModel],
      outputTokens: [
        genAIAttributes.outputTokens,
        genAIAttributes.completionTokens,
      ],
    });
  },
};

function isGenAISemanticConventionSpan(span: ReadableSpan): boolean {
  const system = span.attributes[genAIAttributes.system];
  const operationName = span.attributes[genAIAttributes.operationName];

  return (
    typeof system === "string" &&
    system.length > 0 &&
    typeof operationName === "string" &&
    operationName.length > 0
  );
}
