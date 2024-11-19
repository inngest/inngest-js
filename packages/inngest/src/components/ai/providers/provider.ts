/**
 * TODO
 */
export declare const types: unique symbol;
export type types = typeof types;

/**
 * TODO
 */
export type InferFormat = "openai-chat"; // | "anthropic" | "gemini" | "bedrock";

/**
 * TODO
 */
export interface InferOptions<TProvider extends Provider> {
  /**
   * TODO
   */
  provider: TProvider;

  /**
   * TODO
   */
  body: InferInput<TProvider>;
}

/**
 * TODO
 */
export type InferInput<TProvider extends Provider> = TProvider[types]["input"];

/**
 * TODO
 */
export type InferOutput<TProvider extends Provider> =
  TProvider[types]["output"];

/**
 * TODO
 */
export interface Provider {
  /**
   * TODO
   */
  [types]: {
    /**
     * TODO
     */
    input: unknown;
    /**
     * TODO
     */
    output: unknown;
  };

  /**
   * TODO
   */
  url?: string;

  /**
   * TODO
   */
  headers?: Record<string, string>;

  /**
   * TODO
   */
  authKey: string;

  /**
   * TODO
   */
  format: InferFormat;

  /**
   * TODO
   *
   * Given the provider and a body, mutate them as needed. This is useful for
   * addressing any dynamic changes to the provider options or body based on
   * each other, such as the target URL changing based on a model.
   */
  onCall?: (
    /**
     * TODO
     */
    provider: this,

    /**
     * TODO
     */
    body: this[types]["input"]
  ) => void;
}
