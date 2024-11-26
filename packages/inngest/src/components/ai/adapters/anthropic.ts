import { type AiAdapter, type types } from "../adapter.js";

import { MessageCreateParamsNonStreaming, Message } from "@anthropic-ai/sdk/resources/messages.js";

interface AnthropicInput extends MessageCreateParamsNonStreaming {};
interface AnthropicOutput extends Message {};

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
