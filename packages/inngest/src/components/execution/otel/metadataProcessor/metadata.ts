export const aiMetadataKeys = {
  inputTokens: "input-tokens",
  model: "model",
  outputTokens: "output-tokens",
} as const;

export type AIMetadataValues = Record<string, unknown>;
