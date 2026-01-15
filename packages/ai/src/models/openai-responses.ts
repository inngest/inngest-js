import { type AiAdapter } from "../adapter.js";
import { type OpenAiResponsesAdapter } from "../adapters/openai-responses.js";
import { envKeys, processEnv } from "../env";

/**
 * Create an OpenAI model using the OpenAI Responses API format.
 *
 * By default it targets the `https://api.openai.com/v1/` base URL.
 */
export const openaiResponses: AiAdapter.ModelCreator<
  [options: OpenAiResponses.AiModelOptions],
  OpenAiResponses.AiModel
> = (options) => {
  const authKey = options.apiKey || processEnv(envKeys.OpenAiApiKey) || "";

  // Ensure trailing slash on base URL to avoid path replacement.
  let baseUrl = options.baseUrl || "https://api.openai.com/v1/";
  if (!baseUrl.endsWith("/")) {
    baseUrl += "/";
  }

  const url = new URL("responses", baseUrl);

  return {
    url: url.href,
    authKey,
    format: "openai-responses",
    onCall(_, body) {
      Object.assign(body, options.defaultParameters);
      body.model ||= options.model;
    },
    options,
  } as OpenAiResponses.AiModel;
};

export namespace OpenAiResponses {
  /**
   * IDs of models to use. Keep string passthrough for flexibility.
   */
  export type Model =
    | (string & {})
    | "gpt-5"
    | "gpt-5-mini"
    | "gpt-5-nano"
    | "gpt-4.1-mini"
    | "gpt-4.1"
    | "gpt-4.5-preview"
    | "gpt-4o"
    | "chatgpt-4o-latest"
    | "gpt-4o-mini"
    | "gpt-4"
    | "o1"
    | "o1-preview"
    | "o1-mini"
    | "o3-mini"
    | "gpt-4-turbo"
    | "gpt-3.5-turbo";

  /** Options for creating an OpenAI Responses model. */
  export interface AiModelOptions {
    /** ID of the model to use. */
    model: Model;

    /**
     * The OpenAI API key to use for authenticating your request. By default
     * we'll search for and use the `OPENAI_API_KEY` environment variable.
     */
    apiKey?: string;

    /**
     * The base URL for the OpenAI API.
     * @default "https://api.openai.com/v1/"
     */
    baseUrl?: string;

    /** Default parameters to merge on each call via onCall. */
    defaultParameters?: Partial<AiAdapter.Input<AiModel>>;
  }

  /** An OpenAI Responses model using the Responses format for I/O. */
  export interface AiModel extends OpenAiResponsesAdapter {
    options: AiModelOptions;
  }
}
