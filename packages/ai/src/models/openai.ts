import { type AiAdapter } from "../adapter.js";
import { type OpenAiAiAdapter } from "../adapters/openai.js";
import { envKeys, processEnv } from "../env";

/**
 * Create an OpenAI model using the OpenAI chat format.
 *
 * By default it targets the `https://api.openai.com/v1/` base URL.
 * @deprecated Use `openaiResponses` instead.
 */
export const openai: AiAdapter.ModelCreator<
  [options: OpenAi.AiModelOptions],
  OpenAi.AiModel
> = (options) => {
  const authKey = options.apiKey || processEnv(envKeys.OpenAiApiKey) || "";

  // Ensure we add a trailing slash to our base URL if it doesn't have one,
  // otherwise we'll replace the path instead of appending it.
  let baseUrl = options.baseUrl || "https://api.openai.com/v1/";
  if (!baseUrl.endsWith("/")) {
    baseUrl += "/";
  }

  const url = new URL("chat/completions", baseUrl);

  return {
    url: url.href,
    authKey,
    format: "openai-chat",
    onCall(_, body) {
      Object.assign(body, options.defaultParameters);
      body.model ||= options.model;
    },
    options,
  } as OpenAi.AiModel;
};

export namespace OpenAi {
  /**
   * IDs of models to use. See the [model endpoint
   * compatibility](https://platform.openai.com/docs/models#model-endpoint-compatibility)
   * table for details on which models work with the Chat API.
   */
  export type Model =
    | (string & {})
    | "chatgpt-4o-latest"
    | "codex-mini-latest"
    | "gpt-3.5-turbo"
    | "gpt-3.5-turbo-0125"
    | "gpt-3.5-turbo-0301"
    | "gpt-3.5-turbo-0613"
    | "gpt-3.5-turbo-1106"
    | "gpt-3.5-turbo-16k"
    | "gpt-3.5-turbo-16k-0613"
    | "gpt-4"
    | "gpt-4-0125-preview"
    | "gpt-4-0314"
    | "gpt-4-0613"
    | "gpt-4-1106-preview"
    | "gpt-4-32k"
    | "gpt-4-32k-0314"
    | "gpt-4-32k-0613"
    | "gpt-4-turbo"
    | "gpt-4-turbo-2024-04-09"
    | "gpt-4-turbo-preview"
    | "gpt-4-vision-preview"
    | "gpt-4.1"
    | "gpt-4.1-2025-04-14"
    | "gpt-4.1-mini"
    | "gpt-4.1-mini-2025-04-14"
    | "gpt-4.1-nano"
    | "gpt-4.1-nano-2025-04-14"
    | "gpt-4.5-preview"
    | "gpt-4o"
    | "gpt-4o-2024-05-13"
    | "gpt-4o-2024-08-06"
    | "gpt-4o-2024-11-20"
    | "gpt-4o-audio-preview"
    | "gpt-4o-audio-preview-2024-10-01"
    | "gpt-4o-audio-preview-2024-12-17"
    | "gpt-4o-audio-preview-2025-06-03"
    | "gpt-4o-mini"
    | "gpt-4o-mini-2024-07-18"
    | "gpt-4o-mini-audio-preview"
    | "gpt-4o-mini-audio-preview-2024-12-17"
    | "gpt-4o-mini-search-preview"
    | "gpt-4o-mini-search-preview-2025-03-11"
    | "gpt-4o-search-preview"
    | "gpt-4o-search-preview-2025-03-11"
    | "gpt-5"
    | "gpt-5-2025-08-07"
    | "gpt-5-chat-latest"
    | "gpt-5-mini"
    | "gpt-5-mini-2025-08-07"
    | "gpt-5-nano"
    | "gpt-5-nano-2025-08-07"
    | "gpt-5.1"
    | "gpt-5.1-2025-11-13"
    | "gpt-5.1-chat-latest"
    | "gpt-5.1-codex"
    | "gpt-5.1-mini"
    | "gpt-5.2"
    | "gpt-5.2-2025-12-11"
    | "gpt-5.2-chat-latest"
    | "gpt-5.2-pro"
    | "gpt-5.2-pro-2025-12-11"
    | "o1"
    | "o1-2024-12-17"
    | "o1-mini"
    | "o1-mini-2024-09-12"
    | "o1-preview"
    | "o1-preview-2024-09-12"
    | "o3"
    | "o3-2025-04-16"
    | "o3-mini"
    | "o3-mini-2025-01-31"
    | "o4-mini"
    | "o4-mini-2025-04-16";

  /**
   * Options for creating an OpenAI model.
   */
  export interface AiModelOptions {
    /**
     * ID of the model to use. See the [model endpoint
     * compatibility](https://platform.openai.com/docs/models#model-endpoint-compatibility)
     * table for details on which models work with the Chat API.
     */
    model: Model;

    /**
     * The OpenAI API key to use for authenticating your request. By default we'll
     * search for and use the `OPENAI_API_KEY` environment variable.
     */
    apiKey?: string;

    /**
     * The base URL for the OpenAI API.
     *
     * @default "https://api.openai.com/v1/"
     */
    baseUrl?: string;

    /**
     * Default parameters to use for the model when calling.
     *
     * Note that common parameters like `messages` will likely be overwritten by
     * the adapter.
     */
    defaultParameters?: Partial<AiAdapter.Input<AiModel>>;
  }

  /**
   * An OpenAI model using the OpenAI format for I/O.
   */
  export interface AiModel extends OpenAiAiAdapter {
    options: AiModelOptions;
  }
}
