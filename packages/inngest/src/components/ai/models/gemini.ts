import { envKeys } from "../../../helpers/consts.ts";
import { processEnv } from "../../../helpers/env.ts";
import { type AiAdapter } from "../adapter.ts";
import { type OpenAi, openai } from "./openai.ts";

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
  const apiKey = options.apiKey || processEnv(envKeys.GeminiApiKey);
  const baseUrl =
    options.baseUrl || "https://generativelanguage.googleapis.com/v1beta/";
  const model = options.model as OpenAi.Model;

  return openai({
    ...options,
    apiKey,
    baseUrl,
    model,
  });
};

export namespace Gemini {
  /**
   * IDs of models to use.
   */
  export type Model =
    | "gemini-1.5-flash"
    | "gemini-1.5-flash-8b"
    | "gemini-1.5-pro"
    | "gemini-1.0-pro"
    | "text-embedding-004"
    | "aqa";

  /**
   * Options for creating a Gemini model.
   */
  export interface AiModelOptions extends Omit<OpenAi.AiModelOptions, "model"> {
    /**
     * ID of the model to use.
     */
    model: Gemini.Model;
  }

  /**
   * A Gemini model using the OpenAI format for I/O.
   */
  export type AiModel = OpenAi.AiModel;
}
