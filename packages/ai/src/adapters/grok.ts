import { type AiAdapter } from "../adapter.js";
import { OpenAiAiAdapter } from "./openai.js";

// Grok is an exotic one, it is an OpenAI-compatible API,
// but does not support strict mode Function Calling, requiring an adapter.
export interface GrokAiAdapter extends AiAdapter {
  /**
   * Format of the IO for this model
   */
  format: "grok";

  "~types": {
    input: OpenAiAiAdapter["~types"]["input"];
    output: OpenAiAiAdapter["~types"]["output"];
  };
}
