import { envKeys } from "../../../helpers/consts.js";
import { processEnv } from "../../../helpers/env.js";
import { type AiAdapter } from "../adapter.js";
import { type AnthropicAiAdapter } from "../adapters/anthropic.js";

/**
 * Create an Anthropic model using the Anthropic API format.
 */
export const anthropic: AiAdapter.ModelCreator<
  [options: Anthropic.AiModelOptions],
  Anthropic.AiModel
> = (options) => {
  const authKey = options.apiKey || processEnv(envKeys.AnthropicApiKey) || "";
  let baseUrl = options.baseUrl || "https://api.anthropic.com/v1/";
  if (!baseUrl.endsWith("/")) {
    baseUrl += "/";
  }

  const url = new URL("messages", baseUrl);

  const headers: Record<string, string> = {
    "x-api-key": authKey,
  };

  return {
    url: url.href,
    authKey: "",
    headers,
    format: "anthropic",
  } as Anthropic.AiModel;
};

export namespace Anthropic {
  /**
   * Models to use to complete your prompts.
   */
  export type Model =
    | "claude-3-5-sonnet-latest"
    | "claude-3-5-haiku-latest"
    | "claude-3-opus-latest";

  /**
   * Options for creating an Anthropic model.
   */
  export interface AiModelOptions {
    /**
     * The model that will complete your prompt.
     */
    model: Model;

    /**
     * The Anthropic API key to use for your request. By default we'll search
     * for and use the `ANTHROPIC_API_KEY` environment variable.
     */
    apiKey?: string;

    /**
     * The base URL for the Anthropic API.
     */
    baseUrl?: string;
  }

  export type AiModel = AnthropicAiAdapter;
}
