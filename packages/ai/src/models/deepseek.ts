import { type AiAdapter } from "../adapter.js";
import { type OpenAiAiAdapter } from "../adapters/openai.js";
import { envKeys, processEnv } from "../env";

/**
 * Create a DeepSeek model using the OpenAI-compatible chat format.
 * 
 * By default it targets the `https://api.deepseek.com/v1/` base URL.
 */
export const deepseek: AiAdapter.ModelCreator<
  [options: DeepSeek.AiModelOptions],
  DeepSeek.AiModel
> = (options) => {
  const authKey = options.apiKey || processEnv(envKeys.DeepSeekApiKey) || "";

  // Ensure we add a trailing slash to our base URL if it doesn't have one,
  // otherwise we'll replace the path instead of appending it.
  let baseUrl = options.baseUrl || "https://api.deepseek.com/v1/";
  if (!baseUrl.endsWith("/")) {
    baseUrl += "/";
  }

  const url = new URL("chat/completions", baseUrl);

  return {
    url: url.href,
    authKey,
    format: "openai-chat",
    onCall(_, body) {
      body.model ||= options.model;
    },
    options,
  } as DeepSeek.AiModel;
};

export namespace DeepSeek {
  /**
   * IDs of models available in the DeepSeek API.
   */
  export type Model =
    | "deepseek-chat"
    | "deepseek-reasoner";

  /**
   * Options for creating a DeepSeek model.
   */
  export interface AiModelOptions {
    /**
     * ID of the model to use. Currently supports 'deepseek-chat' (DeepSeek-V3) 
     * and 'deepseek-reasoner' (DeepSeek-R1).
     */
    model: Model;

    /**
     * The DeepSeek API key to use for authenticating your request. By default we'll
     * search for and use the `DEEPSEEK_API_KEY` environment variable.
     */
    apiKey?: string;

    /**
     * The base URL for the DeepSeek API.
     *
     * @default "https://api.deepseek.com/v1/"
     */
    baseUrl?: string;
  }

  /**
   * A DeepSeek model using the OpenAI-compatible format for I/O.
   */
  export interface AiModel extends OpenAiAiAdapter {
    options: AiModelOptions;
  }
} 