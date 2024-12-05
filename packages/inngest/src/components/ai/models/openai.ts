import { envKeys } from "../../../helpers/consts.js";
import { processEnv } from "../../../helpers/env.js";
import { type AiAdapter } from "../adapter.js";
import { type OpenAiAiAdapter } from "../adapters/openai.js";

/**
 * Create an OpenAI model using the OpenAI chat format.
 *
 * By default it targets the `https://api.openai.com/v1/` base URL.
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
    | "gpt-4o"
    | "chatgpt-4o-latest"
    | "gpt-4o-mini"
    | "gpt-4"
    | "o1-preview"
    | "o1-mini"
    | "gpt-3.5-turbo";

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
  }

  /**
   * An OpenAI model using the OpenAI format for I/O.
   */
  export type AiModel = OpenAiAiAdapter & { options: AiModelOptions };
}
