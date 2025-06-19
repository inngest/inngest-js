import { type OpenAiAiAdapter } from "./openai.js";

/**
 * An Azure OpenAI model using the OpenAI format for I/O.
 */
export interface AzureOpenAiAiAdapter extends Omit<OpenAiAiAdapter, "format"> {
  format: "azure-openai";
  "~types": {
    input: OpenAiAiAdapter["~types"]["input"];
    output: OpenAiAiAdapter["~types"]["output"];
  };
}

export namespace AzureOpenAiAiAdapter {
  /**
   * Common deployment names for Azure OpenAI.
   * You can also use custom deployment names by providing any string.
   */
  export type Deployment =
    // eslint-disable-next-line @typescript-eslint/ban-types
    | (string & {})
    // Chat models
    | "gpt-4o"
    | "gpt-4o-mini"
    | "gpt-35-turbo"
    | "gpt-4"
    | "gpt-4-32k"
    | "gpt-4-turbo"
    | "gpt-4.1"
    | "gpt-4.1-mini"
    | "gpt-4.1-nano"
    // Reasoning models
    | "o1"
    | "o1-mini"
    | "o3"
    | "o3-mini"
    | "o4-mini";
}
