import { type AiAdapter, type types } from "../adapter.js";

export interface AnthropicAiAdapter extends AiAdapter {
  format: "anthropic";

  [types]: {
    input: {
      /**
       * The model that will complete your prompt.
       */
      model?: string;

      messages: {
        role: "user" | "assistant";
        content:
          | string
          | (
              | AnthropicAiAdapter.Message.ContentText
              | AnthropicAiAdapter.Message.ContentImage
              | AnthropicAiAdapter.Message.ContentToolUse
              | AnthropicAiAdapter.Message.ContentToolResult
              | AnthropicAiAdapter.Message.ContentDocument
            )[];
      }[];

      /**
       * The maximum number of tokens to generate before stopping.
       *
       * Note that our models may stop before reaching this maximum. This
       * parameter only specifies the absolute maximum number of tokens to
       * generate.
       *
       * Different models have different maximum values for this parameter. See
       * [models](https://docs.anthropic.com/en/docs/models-overview) for
       * details.
       */
      max_tokens: number;

      /**
       * An object describing metadata about the request.
       */
      metadata?: {
        /**
         * An external identifier for the user who is associated with the
         * request.
         *
         * This should be a uuid, hash value, or other opaque identifier.
         * Anthropic may use this id to help detect abuse. Do not include any
         * identifying information such as name, email address, or phone number.
         */
        user_id?: string | null;
      };

      /**
       * Custom text sequences that will cause the model to stop generating.
       *
       * Our models will normally stop when they have naturally completed their
       * turn, which will result in a response `stop_reason` of `"end_turn"`.
       *
       * If you want the model to stop generating when it encounters custom
       * strings of text, you can use the `stop_sequences` parameter. If the
       * model encounters one of the custom sequences, the response
       * `stop_reason` value will be `"stop_sequence"` and the response
       * `stop_sequence` value will contain the matched stop sequence.
       */
      stop_sequences?: string[];

      /**
       * System prompt.
       *
       * A system prompt is a way of providing context and instructions to
       * Claude, such as specifying a particular goal or role. See our [guide to
       * system prompts](https://docs.anthropic.com/en/docs/system-prompts).
       */
      system?: string | AnthropicAiAdapter.Message.ContentText;

      /**
       * Amount of randomness injected into the response.
       *
       * Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer
       * to `0.0` for analytical / multiple choice, and closer to `1.0` for
       * creative and generative tasks.
       *
       * Note that even with `temperature` of `0.0`, the results will not be
       * fully deterministic.
       */
      temperature?: number;

      tool_choice?:
        | {
            type: "auto";

            /**
             * Whether to disable parallel tool use.
             *
             * Defaults to `false`. If set to `true`, the model will output at
             * most one tool use.
             */
            disable_parallel_tool_use?: boolean;
          }
        | {
            type: "any";

            /**
             * Whether to disable parallel tool use.
             *
             * Defaults to `false`. If set to `true`, the model will output at
             * most one tool use.
             */
            disable_parallel_tool_use?: boolean;
          }
        | {
            type: "tool";

            /**
             * The name of the tool to use.
             */
            name: string;

            /**
             * Whether to disable parallel tool use.
             *
             * Defaults to `false`. If set to `true`, the model will output at
             * most one tool use.
             */
            disable_parallel_tool_use?: boolean;
          };

      tools?: (
        | {
            type?: "custom" | null;

            /**
             * Description of what this tool does.
             *
             * Tool descriptions should be as detailed as possible. The more
             * information that the model has about what the tool is and how to
             * use it, the better it will perform. You can use natural language
             * descriptions to reinforce important aspects of the tool input
             * JSON schema.
             */
            description?: string;

            /**
             * Name of the tool.
             *
             * This is how the tool will be called by the model and in tool_use
             * blocks.
             */
            name: string;

            /**
             * [JSON schema](https://json-schema.org/) for this tool's input.
             *
             * This defines the shape of the input that your tool accepts and
             * that the model will produce.
             */
            input_schema: {
              type: "object";
              properties?: Record<string, unknown> | null;
            };

            cache_control?: AnthropicAiAdapter.CacheControl;
          }
        | {
            type: "computer_20241022";
            cache_control?: AnthropicAiAdapter.CacheControl;

            /**
             * Name of the tool.
             *
             * This is how the tool will be called by the model and in tool_use
             * blocks.
             */
            name: string;

            /**
             * The height of the display in pixels.
             */
            display_height_px: number;

            /**
             * The width of the display in pixels.
             */
            display_width_px: number;

            /**
             * The X11 display number (e.g. 0, 1) for the display.
             */
            display_number?: number | null;
          }
        | {
            type: "bash_20241022";
            cache_control?: AnthropicAiAdapter.CacheControl;

            /**
             * Name of the tool.
             *
             * This is how the tool will be called by the model and in tool_use
             * blocks.
             */
            name: string;
          }
        | {
            type: "text_editor_20241022";
            cache_control?: AnthropicAiAdapter.CacheControl;

            /**
             * Name of the tool.
             *
             * This is how the tool will be called by the model and in tool_use
             * blocks.
             */
            name: string;
          }
      )[];

      /**
       * Only sample from the top K options for each subsequent token.
       *
       * Used to remove "long tail" low probability responses. [Learn more
       * technical details
       * here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).
       *
       * Recommended for advanced use cases only. You usually only need to use
       * `temperature`.
       */
      top_k?: number;

      /**
       * Use nucleus sampling.
       *
       * In nucleus sampling, we compute the cumulative distribution over all
       * the options for each subsequent token in decreasing probability order
       * and cut it off once it reaches a particular probability specified by
       * `top_p`. You should either alter `temperature` or `top_p`, but not
       * both.
       *
       * Recommended for advanced use cases only. You usually only need to use
       * `temperature`.
       */
      top_p?: number;
    };

    output: {
      /**
       * Unique object identifier.
       *
       * The format and length of IDs may change over time.
       */
      id: string;

      /**
       * Object type.
       *
       * The Messages, this is always `"message"`.
       */
      type: "message";

      /**
       * Conversational role of the generated message.
       *
       * This will always be `"assistant"`.
       */
      role: "assistant";

      /**
       * Content generated by the model.
       *
       * This is an array of content blocks, each of which has a type that
       * determines its shape.
       *
       * Example:
       *
       * ```
       * [{"type": "text", "text": "Hi, I'm Claude."}]
       * ```
       *
       * If the request input messages ended with an assistant turn, then the
       * response content will continue directly from that last turn. You can
       * use this to constrain the model's output.
       *
       * For example, if the input messages were:
       *
       * ```
       * [
       *   {"role": "user", "content": "What's the Greek name for Sun? (A) Sol (B) Helios (C) Sun"},
       *   {"role": "assistant", "content": "The best answer is ("}
       * ]
       * ```
       *
       * Then the response content might be:
       *
       * ```
       * [{"type": "text", "text": "B)"}]
       * ```
       */
      content: (
        | Omit<AnthropicAiAdapter.Message.ContentText, "cache_control">
        | Omit<AnthropicAiAdapter.Message.ContentToolUse, "cache_control">
      )[];

      /**
       * The model that handled the request.
       */
      model: string;

      /**
       * The reason that we stopped.
       *
       * This may be one the following values:
       *
       * - `"end_turn"`: the model reached a natural stopping point
       * - `"max_tokens"`: we exceeded the requested `max_tokens` or the model's
       *   maximum
       * - `"stop_sequence"`: one of your provided custom `stop_sequences` was
       *   generated
       * - `"tool_use"`: the model invoked one or more tools
       *
       * In non-streaming mode this value is always non-null. In streaming mode,
       * it is null in the `message_start` event and non-null otherwise.
       */
      stop_reason:
        | "end_turn"
        | "max_tokens"
        | "stop_sequence"
        | "tool_use"
        | null;

      /**
       * Which custom stop sequence was generated, if any.
       *
       * This value will be a non-null string if one of your custom stop
       * sequences was generated.
       */
      stop_sequence: string | null;

      /**
       * Billing and rate-limit usage.
       *
       * Anthropic's API bills and rate-limits by token counts, as tokens
       * represent the underlying cost to our systems.
       *
       * Under the hood, the API transforms requests into a format suitable for
       * the model. The model's output then goes through a parsing stage before
       * becoming an API response. As a result, the token counts in `usage` will
       * not match one-to-one with the exact visible content of an API request
       * or response.
       *
       * For example, `output_tokens` will be non-zero, even for an empty string
       * response from Claude.
       */
      usage: {
        /**
         * The number of input tokens which were used.
         */
        input_tokens: number;

        /**
         * The number of input tokens used to create the cache entry.
         */
        cache_creation_input_tokens: number | null;

        /**
         * The number of input tokens read from the cache.
         */
        cache_read_input_tokens: number | null;

        /**
         * The number of output tokens which were used.
         */
        output_tokens: number;
      };
    };
  };
}

export namespace AnthropicAiAdapter {
  export type CacheControl = { type: "ephemeral" } | null;

  export namespace Message {
    export interface ContentText {
      type: "text";
      text: string;
      cache_control?: AnthropicAiAdapter.CacheControl;
    }

    export interface ContentImage {
      type: "image";
      cache_control?: AnthropicAiAdapter.CacheControl;
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    }

    export interface ContentToolUse {
      type: "tool_use";
      cache_control?: AnthropicAiAdapter.CacheControl;
      id: string;
      name: string;
      input: unknown;
    }

    export interface ContentToolResult {
      type: "tool_result";
      cache_control?: AnthropicAiAdapter.CacheControl;
      tool_use_id: string;
      is_error: boolean;
      content: string | (ContentText | ContentImage)[];
    }

    export interface ContentDocument {
      type: "document";
      cache_control?: AnthropicAiAdapter.CacheControl;
      source: {
        type: "base64";
        media_type: "application/pdf";
        data: string;
      };
    }
  }
}
