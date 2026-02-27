import { type AiAdapter } from "../adapter.js";
import { GrokAiAdapter } from "../adapters/grok.js";
import { envKeys, processEnv } from "../env";
import { type OpenAi, openai } from "./openai.js";

/**
 * Create a Grok model using the OpenAI chat format.
 *
 * By default it targets the `https://api.x.ai/v1`
 * base URL.
 */
export const grok: AiAdapter.ModelCreator<
  [options: Grok.AiModelOptions],
  Grok.AiModel
> = (options) => {
  const apiKey = options.apiKey || processEnv(envKeys.GrokApiKey);
  const baseUrl = options.baseUrl || "https://api.x.ai/v1";
  const model = options.model as Grok.Model;

  const adapter = openai({
    ...options,
    apiKey,
    baseUrl,
    model,
  }) as unknown as Grok.AiModel;

  adapter.format = "grok";

  return adapter;
};

export namespace Grok {
  /**
   * IDs of models to use.
   */
  export type Model =
    | (string & {})
    | "grok-2"
    | "grok-2-1212"
    | "grok-2-latest"
    | "grok-3"
    | "grok-3-fast"
    | "grok-3-fast-latest"
    | "grok-3-latest"
    | "grok-3-mini"
    | "grok-3-mini-fast"
    | "grok-3-mini-fast-latest"
    | "grok-3-mini-latest"
    | "grok-4"
    | "grok-4-0709"
    | "grok-4-1"
    | "grok-4-1-fast-non-reasoning"
    | "grok-4-1-fast-reasoning"
    | "grok-4-fast-non-reasoning"
    | "grok-4-fast-reasoning"
    | "grok-4-latest"
    | "grok-code-fast-1";

  /**
   * Options for creating a Gemini model.
   */
  export interface AiModelOptions extends Omit<OpenAi.AiModelOptions, "model"> {
    /**
     * ID of the model to use.
     */
    model: Grok.Model;

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
  export type AiModel = GrokAiAdapter;
}
