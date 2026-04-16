import { type AiAdapter } from "../adapter.js";
import { OpenAiAiAdapter } from "./openai.js";

// Tzafon is an OpenAI-compatible API, but does not support tool/function
// calling. It rejects requests containing `tools` or `tool_choice` with a 400,
// requiring an adapter that strips these fields.
export interface TzafonAiAdapter extends AiAdapter {
  /**
   * Format of the IO for this model
   */
  format: "tzafon";

  "~types": {
    input: OpenAiAiAdapter["~types"]["input"];
    output: OpenAiAiAdapter["~types"]["output"];
  };
}
