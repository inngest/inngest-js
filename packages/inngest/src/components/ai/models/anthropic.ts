import { envKeys } from "../../../helpers/consts.js";
import { processEnv } from "../../../helpers/env.js";
import { type AiAdapter } from "../adapter.js";
import { type AnthropicAdapter, AnthropicModel, AnthropicBeta } from "../adapters/anthropic.js";

/**
 * Create an OpenAI model using the OpenAI chat format.
 *
 * By default it targets the `https://api.openai.com/v1/` base URL.
 */
export const openai: AiAdapter.ModelCreator<
  [options: Anthropic.AiModelOptions],
  Anthropic.AiModel
> = (options) => {
  const authKey = options.apiKey || processEnv(envKeys.AnthropicApiKey) || "";

  // Ensure we add a trailing slash to our base URL if it doesn't have one,
  // otherwise we'll replace the path instead of appending it.
  let baseUrl = options.baseUrl || "https://api.anthropic.com/v1/";
  if (!baseUrl.endsWith("/")) {
    baseUrl += "/";
  }

  const url = new URL("messages", baseUrl);

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  };

  if ((options.betaHeaders?.length || 0) > 0) {
    headers["anthropic-beta"] = options.betaHeaders?.join(",") || "";
  }

  return {
    url: url.href,
    authKey,
    format: "anthropic",
    onCall(_, body) {
      body.model ||= options.model;
    },
    headers,
  } as Anthropic.AiModel;
};

export namespace Anthropic {
  /**
   * IDs of models to use. See the [model endpoint
   * compatibility](https://docs.anthropic.com/en/docs/about-claude/models)
   * table for details on which models work with the Anthropic API.
   */
  export type Model = AnthropicModel;

  /**
   * Options for creating an OpenAI model.
   */
  export interface AiModelOptions {
    /**
     * ID of the model to use. See the [model endpoint
     * compatibility](https://docs.anthropic.com/en/docs/about-claude/models)
     * table for details on which models work with the Anthropic API.
     */
    model: Model;

    /**
     * The OpenAI API key to use for authenticating your request. By default we'll
     * search for and use the `ANTHROPIC_API_KEY` environment variable.
     */
    apiKey?: string;

    /**
     * The beta headers to enable, eg. for computer use, prompt caching, and so on
     */
    betaHeaders?: AnthropicBeta[];

    /**
     * The base URL for the Anthropic API.
     *
     * @default "https://api.anthropic.com/v1/"
     */
    baseUrl?: string;
  }

  /**
   * An Anthropic model using the Anthropic format for I/O.
   */
  export type AiModel = AnthropicAdapter;
}

