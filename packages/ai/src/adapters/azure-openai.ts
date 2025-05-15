import { type AiAdapter } from "../adapter.js"
import { type OpenAiAiAdapter } from "./openai.js"

/**
 * An Azure OpenAI model using the OpenAI format for I/O.
 */
export interface AzureOpenAiAiAdapter extends Omit<OpenAiAiAdapter, "format"> {
  format: "azure-openai"
  "~types": {
    input: OpenAiAiAdapter["~types"]["input"]
    output: OpenAiAiAdapter["~types"]["output"]
  }
}
