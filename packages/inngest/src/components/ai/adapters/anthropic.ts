import { type Anthropic } from "@anthropic-ai/sdk";
import { type AiAdapter, type types } from "../adapter.js";

export interface AnthropicAiAdapter extends AiAdapter {
  /**
   * Format of the IO for this model
   */
  format: "anthropic";

  [types]: {
    input: AnthropicAiAdapter.Input;
    output: AnthropicAiAdapter.Output;
  };
}

export namespace AnthropicAiAdapter {
  export interface Input extends Anthropic.MessageCreateParamsNonStreaming {}
  export interface Output extends Anthropic.Message {}
  export type Model = Anthropic.Model;
  export type Beta = Anthropic.AnthropicBeta;
}
