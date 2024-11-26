import { type AiAdapter, type types } from "../adapter.js";

import { MessageCreateParamsNonStreaming, Message, Model } from "@anthropic-ai/sdk/resources/messages.js";
import { AnthropicBeta as AnthropicBetaSDK } from "@anthropic-ai/sdk/resources/index.js";

interface AnthropicInput extends MessageCreateParamsNonStreaming {};
interface AnthropicOutput extends Message {};
export type AnthropicModel = Model;
export type AnthropicBeta = AnthropicBetaSDK;

export interface AnthropicAdapter extends AiAdapter {

  /**
   * Format of the IO for this model
   */
  format: "anthropic";

  [types]: {
    input: AnthropicInput ,
    output: AnthropicOutput,
  }
}
