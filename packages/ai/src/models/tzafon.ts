import { type AiAdapter } from "../adapter.js";
import { type OpenAiAiAdapter } from "../adapters/openai.js";
import { envKeys, processEnv } from "../env";

/**
 * Create a Tzafon model using the OpenAI-compatible chat format.
 *
 * By default it targets the `https://api.tzafon.ai/v1/` base URL.
 */
export const tzafon: AiAdapter.ModelCreator<
  [options: Tzafon.AiModelOptions],
  Tzafon.AiModel
> = (options) => {
  const authKey = options.apiKey || processEnv(envKeys.TzafonApiKey) || "";

  // Ensure we add a trailing slash to our base URL if it doesn't have one,
  // otherwise we'll replace the path instead of appending it.
  let baseUrl = options.baseUrl || "https://api.tzafon.ai/v1/";
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
  } as Tzafon.AiModel;
};

export namespace Tzafon {
  /**
   * IDs of models available in the Tzafon API.
   */
  export type Model = "tzafon.sm-1" | "tzafon.northstar-cua-fast" | (string & {});

  /**
   * Options for creating a Tzafon model.
   */
  export interface AiModelOptions {
    /**
     * ID of the model to use. Currently supports 'tzafon.sm-1' (general tasks)
     * and 'tzafon.northstar-cua-fast' (computer-use automation).
     */
    model: Model;

    /**
     * The Tzafon API key to use for authenticating your request. By default we'll
     * search for and use the `TZAFON_API_KEY` environment variable.
     */
    apiKey?: string;

    /**
     * The base URL for the Tzafon API.
     *
     * @default "https://api.tzafon.ai/v1/"
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
   * A Tzafon model using the OpenAI-compatible format for I/O.
   */
  export interface AiModel extends OpenAiAiAdapter {
    options: AiModelOptions;
  }
}
