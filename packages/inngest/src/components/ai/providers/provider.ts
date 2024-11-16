export type ProviderType = "openai" | "anthropic";

export interface AIInferenceOptions<TInput = unknown, TOutput = unknown> {
  opts?: {
    baseURL?: string;
    authorization?: Record<string, string>;
    auto_tool_call?: boolean;
    headers?: Record<string, string>[];
    format?: string;
  };
  model?: string;
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
}

export type InferFormat = "openai-chat" | "anthropic" | "gemini" | "bedrock";

export interface InferRequestOpts {
  url?: string;
  headers?: Record<string, string>;
  authKey: string;
  format: InferFormat;
}

export interface InferOpts<TRequest> {
  opts: InferRequestOpts;
  body: TRequest;
}

export function openai(key?: string, baseURL?: string): InferRequestOpts {
  const api = key ?? process.env.OPENAI_API_KEY ?? "";
  const base = baseURL ?? "https://api.openai.com";

  return {
    url: `${base}/v1/chat/completions`,
    authKey: api,
    format: "openai-chat",
  };
}
