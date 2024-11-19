import { envKeys } from "../../../helpers/consts.js";
import { processEnv } from "../../../helpers/env.js";
import { type Provider, type types } from "./provider.js";

/**
 * TODO
 */
export interface OpenAiProvider extends Provider {
  /**
   * TODO
   */
  format: "openai-chat";

  [types]: {
    input: {
      model?: string;
      messages: {
        role: string;
        content: string;
      }[];
    };
    output: {
      choices: {
        role: string;
        content: string;
      }[];
    };
  };
}

/**
 * TODO
 */
export interface OpenAiProviderOptions {
  /**
   * TODO
   */
  model: "gpt-3.5-turbo";

  /**
   * TODO
   */
  apiKey?: string;

  /**
   * TODO
   */
  baseURL?: string;
}

/**
 * TODO
 */
export const openai = (options: OpenAiProviderOptions): OpenAiProvider => {
  const authKey = options.apiKey || processEnv(envKeys.OpenAiApiKey) || "";

  const url = new URL(
    "/v1/chat/completions",
    options.baseURL || "https://api.openai.com"
  );

  return {
    url: url.href,
    authKey,
    format: "openai-chat",
    onCall(provider, body) {
      body.model ||= options.model;
    },
  } as OpenAiProvider;
};
