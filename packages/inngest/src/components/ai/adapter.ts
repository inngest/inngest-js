import { type AnthropicAiAdapter } from "./adapters/anthropic.js";
import { type OpenAiAiAdapter } from "./adapters/openai.js";

/**
 * A symbol used internally to define the types for a model whilst keeping
 * generics clean. Must not be exported outside of this module.
 */
export declare const types: unique symbol;
export type types = typeof types;

/**
 * An AI model, defining the I/O format and typing, and how to call the model.
 *
 * Models should extend this interface to define their own input and output
 * types.
 */
export interface AiAdapter {
  /**
   * The I/O format for the adapter.
   */
  format: AiAdapter.Format;

  /**
   * The constructor options for the adapter.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;

  /**
   * The input and output types for this AI I/O format.
   *
   * This is not accessible externally, and is only used internally to define
   * the user-facing types for each model in a way that avoids using generics.
   */
  [types]: {
    /**
     * The input typing for the format.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any;
    /**
     * The output typing for the format.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output: any;
  };

  /**
   * The URL to use for the format.
   */
  url?: string;

  /**
   * Headers to pass to the format.
   */
  headers?: Record<string, string>;

  /**
   * The authentication key to use for the format.
   */
  authKey: string;

  /**
   * Given the model and a body, mutate them as needed. This is useful for
   * addressing any dynamic changes to the model options or body based on each
   * other, such as the target URL changing based on a model.
   */
  onCall?: (
    /**
     * The model to use for the inference.
     */
    model: AiAdapter,

    /**
     * The input to pass to the model.
     */
    body: this[types]["input"]
  ) => void;
}

/**
 * An AI model, defining the I/O format and typing, and how to call the model.
 *
 * Models should extend this interface to define their own input and output
 * types.
 */
export namespace AiAdapter {
  export interface Any extends Omit<AiAdapter, "format"> {
    /**
     * The I/O format for the adapter.
     *
     * Allows any value, such that this type can be easily used with any
     * adapter.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    format: any;
  }

  /**
   * A helper used to infer the input type of an adapter.
   */
  export type Input<TAdapter extends AiAdapter> = TAdapter[types]["input"];

  /**
   * A helper used to infer the output type of an adapter.
   */
  export type Output<TAdapter extends AiAdapter> = TAdapter[types]["output"];

  /**
   * Supported I/O formats for AI models.
   */
  export type Format = "openai-chat" | "anthropic";

  /**
   * A function that creates a model that adheres to an existng AI adapter
   * interface.
   */
  export type ModelCreator<
    TInput extends unknown[],
    TOutput extends AiAdapter,
  > = (...args: TInput) => TOutput;
}

/**
 * A cheeky hack to ensure we account for all AI adapters.
 */
const adapters = {
  "openai-chat": null as unknown as OpenAiAiAdapter,
  anthropic: null as unknown as AnthropicAiAdapter,
} satisfies Record<AiAdapter.Format, AiAdapter>;

/**
 * All AI adapters available for use.
 */
export type AiAdapters = typeof adapters;
