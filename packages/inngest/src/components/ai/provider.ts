/**
 * A symbol used internally to define the types for a provider whilst keeping
 * generics clean. Must not be exported outside of this module.
 */
export declare const types: unique symbol;
export type types = typeof types;

/**
 * Supported I/O formats for AI providers.
 */
export type InferFormat = "openai-chat"; // | "anthropic" | "gemini" | "bedrock";

/**
 * Options for `step.ai.infer()`.
 */
export interface InferOptions<TProvider extends Provider> {
  /**
   * The provider to use for the inference. Create a provider by importing from
   * `"inngest"` or by using `step.ai.providers.*`.
   *
   * @example Import `openai()`
   * ```ts
   * import { openai } from "inngest";
   *
   * const provider = openai({ model: "gpt-4" });
   * ```
   *
   * @example Use a provider from `step.ai.providers`
   * ```ts
   * async ({ step }) => {
   *            const provider = step.ai.providers.openai({ model: "gpt-4" });
   * }
   * ```
   */
  provider: TProvider;

  /**
   * The input to pass to the provider.
   */
  body: InferInput<TProvider>;
}

/**
 * A helper used to infer the input type of a provider.
 */
export type InferInput<TProvider extends Provider> = TProvider[types]["input"];

/**
 * A helper used to infer the output type of a provider.
 */
export type InferOutput<TProvider extends Provider> =
  TProvider[types]["output"];

/**
 * An AI inference provider, defining the I/O format and typing.
 *
 * Providers should extend this interface to define their own input and output
 * types.
 */
export interface Provider {
  /**
   * The input and output types for the provider.
   *
   * This is not accessible externally, and is only used internally to define
   * the user-facing types for each provider in a way that avoids using
   * generics.
   */
  [types]: {
    /**
     * The input typing for the provider.
     */
    input: unknown;
    /**
     * The output typing for the provider.
     */
    output: unknown;
  };

  /**
   * The URL to use for the provider.
   */
  url?: string;

  /**
   * Headers to pass to the provider.
   */
  headers?: Record<string, string>;

  /**
   * The authentication key to use for the provider.
   */
  authKey: string;

  /**
   * The format of the provider.
   */
  format: InferFormat;

  /**
   * Given the provider and a body, mutate them as needed. This is useful for
   * addressing any dynamic changes to the provider options or body based on
   * each other, such as the target URL changing based on a model.
   */
  onCall?: (
    /**
     * The provider to use for the inference.
     */
    provider: this,

    /**
     * The input to pass to the provider.
     */
    body: this[types]["input"]
  ) => void;
}
