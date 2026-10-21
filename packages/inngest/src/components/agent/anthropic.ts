/**
 * @module
 * EXPERIMENTAL: `agent.anthropic()`, an `AgentModel` for the Anthropic
 * Messages API. It imports nothing from `@anthropic-ai/sdk`: every request and
 * reply type is read from the client you pass, so your own SDK version decides
 * which models and options type-check.
 */
import type { AgentModel } from "./loop.ts";
import { modelError } from "./modelErrors.ts";

/**
 * What it takes to accept a client: something with `messages.create`.
 */
export interface AnthropicClientLike {
  messages: { create: (...args: never[]) => PromiseLike<unknown> };
}

/**
 * The non-streaming overload of `create`, as `[request, reply]`. The pattern
 * lines up with the last three overloads: non-streaming, streaming, either.
 */
type NonStreaming<TCreate> = TCreate extends {
  (request: infer TRequest, ...rest: never[]): infer TReply;
  (...rest: never[]): unknown;
  (...rest: never[]): unknown;
}
  ? [TRequest, Awaited<TReply>]
  : never;

type Create<TClient extends AnthropicClientLike> = NonStreaming<
  TClient["messages"]["create"]
>;

/**
 * A request to `messages.create` as your SDK types it.
 */
export type AnthropicRequest<TClient extends AnthropicClientLike> = Omit<
  Create<TClient>[0],
  "stream"
>;

type Reply<TClient extends AnthropicClientLike> = Create<TClient>[1];

type ReplyBlock<TClient extends AnthropicClientLike> = Reply<TClient> extends {
  content: (infer TBlock)[];
}
  ? TBlock
  : never;

export type AnthropicOptions<TClient extends AnthropicClientLike> = Omit<
  AnthropicRequest<TClient>,
  "messages" | "tools" | "system"
> & {
  /**
   * Changes the whole request just before it is sent, for anything the
   * options can't say per turn: `thinking`, `output_config`, trimming
   * `messages`, or `tool_choice` on the last turn. Return the request.
   */
  params?: (
    request: AnthropicRequest<TClient>,
    turn: { turn: number; maxTurns: number },
  ) => AnthropicRequest<TClient>;
};

/**
 * EXPERIMENTAL: An `AgentModel` that calls `client.messages.create()`. The
 * options are that method's own request options (`model`, `max_tokens`,
 * `temperature`, ...), typed by your SDK.
 *
 * The assistant's content is kept as the API returned it, so thinking
 * signatures go back untouched. The SDK's own retries are off, since Inngest
 * retries the step: a 400, 401, 403, 404, 413 or 422 is not retried, and a 429
 * or 529 waits for `retry-after`.
 *
 * @example
 * ```ts
 * import Anthropic from "@anthropic-ai/sdk";
 * import { agent } from "inngest/experimental";
 *
 * const claude = agent.anthropic(new Anthropic(), {
 *   model: "claude-sonnet-5-5",
 *   max_tokens: 8192,
 * });
 *
 * await agent.loop({ model: claude, prompt, tools });
 * ```
 */
export const anthropic = <TClient extends AnthropicClientLike>(
  client: TClient,
  options: NoInfer<AnthropicOptions<TClient>>,
): AgentModel => {
  const { params, ...fixed } = options;
  const messages = client.messages as unknown as {
    create: (
      request: unknown,
      options: { maxRetries: number },
    ) => Promise<Reply<TClient>>;
  };

  return async (request) => {
    const hasTools = request.tools.length > 0;
    const body = {
      ...fixed,
      ...(request.system !== undefined && { system: request.system }),
      ...(hasTools && { tools: request.tools }),
      ...(hasTools &&
        request.toolChoice && { tool_choice: { type: request.toolChoice } }),
      messages: request.messages.map((message) => {
        if (message.role !== "tool") {
          return message;
        }

        return {
          role: "user",
          content: message.results.map((result) => {
            return {
              type: "tool_result",
              tool_use_id: result.toolCallId,
              content: result.content,
              ...(result.isError && { is_error: true }),
            };
          }),
        };
      }),
    } as unknown as AnthropicRequest<TClient>;
    const sent = params
      ? params(body, { turn: request.turn, maxTurns: request.maxTurns })
      : body;

    let reply: Reply<TClient>;

    try {
      reply = await messages.create(sent, { maxRetries: 0 });
    } catch (error) {
      throw modelError(error);
    }

    const blocks = (reply as { content: ReplyBlock<TClient>[] }).content as {
      type: string;
      id: string;
      name: string;
      input: unknown;
      text: string;
    }[];
    const { usage } = reply as {
      usage?: { input_tokens: number; output_tokens: number };
    };

    return {
      message: { role: "assistant", content: blocks },
      text: blocks
        .filter((block) => {
          return block.type === "text";
        })
        .map((block) => {
          return block.text;
        })
        .join("\n"),
      toolCalls: blocks
        .filter((block) => {
          return block.type === "tool_use";
        })
        .map((block) => {
          return { id: block.id, name: block.name, input: block.input };
        }),
      usage: usage && {
        input: usage.input_tokens,
        output: usage.output_tokens,
      },
    };
  };
};
