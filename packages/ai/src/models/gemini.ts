/* eslint-disable @typescript-eslint/no-namespace */
import { type AiAdapter } from "../adapter.js";
import { type GeminiAiAdapter } from "../adapters/gemini.js";
import { envKeys, processEnv } from "../env";

/**
 * Create a Gemini model using the OpenAI chat format.
 *
 * By default it targets the `https://generativelanguage.googleapis.com/v1beta/`
 * base URL.
 */
export const gemini: AiAdapter.ModelCreator<
  [options: Gemini.AiModelOptions],
  Gemini.AiModel
> = (options) => {
  const authKey = options.apiKey || processEnv(envKeys.GeminiApiKey) || "";

  // Ensure we add a trailing slash to our base URL if it doesn't have one,
  // otherwise we'll replace the path instead of appending it.
  let baseUrl =
    options.baseUrl || "https://generativelanguage.googleapis.com/v1beta/";
  if (!baseUrl.endsWith("/")) {
    baseUrl += "/";
  }

  const url = new URL(
    `models/${options.model}:generateContent?key=${authKey}`,
    baseUrl,
  );

  const headers: Record<string, string> = {};

  return {
    url: url.href,
    authKey,
    format: "gemini",
    onCall(_, body) {
      if (!options.defaultParameters) {
        return;
      }

      const { generationConfig: defaultGenerationConfig, ...otherDefaults } =
        options.defaultParameters;

      // Assign top-level defaults first, user-provided values will override
      Object.assign(body, {
        ...otherDefaults,
        ...body,
      });

      // Then, deep-merge generationConfig
      if (defaultGenerationConfig) {
        body.generationConfig = {
          ...defaultGenerationConfig,
          ...(body.generationConfig || {}),
          // And ensure nested thinkingConfig is also deep-merged
          thinkingConfig: {
            ...defaultGenerationConfig.thinkingConfig,
            ...(body.generationConfig?.thinkingConfig || {}),
          },
        };
      }
    },
    headers,
    options,
  } as Gemini.AiModel;
};

export namespace Gemini {
  /**
   * IDs of models to use.
   */
  export type Model = GeminiAiAdapter.Model;

  /**
   * Options for creating a Gemini model.
   */
  export interface AiModelOptions {
    /**
     * ID of the model to use.
     */
    model: Gemini.Model;

    /**
     * The Anthropic API key to use for authenticating your request. By default
     * we'll search for and use the `ANTHROPIC_API_KEY` environment variable.
     */
    apiKey?: string;

    /**
     * The base URL for the Gemini API.
     *
     * @default "https://generativelanguage.googleapis.com/v1beta/"
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
   * A Gemini model using the OpenAI format for I/O.
   */
  export interface AiModel extends GeminiAiAdapter {
    options: AiModelOptions;
  }
}
