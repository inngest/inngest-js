/**
 * @module
 * EXPERIMENTAL: `agent.openai()`, an `AgentModel` for the OpenAI Responses
 * API. It imports nothing from `openai`: every request and reply type is read
 * from the client you pass, so your own SDK version decides which models and
 * options type-check.
 */
import type { AgentModel } from "./loop.ts";
import { modelError } from "./modelErrors.ts";

/**
 * What it takes to accept a client: something with `responses.create`.
 */
export interface OpenAIClientLike {
  responses: { create: (...args: never[]) => PromiseLike<unknown> };
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

type Create<TClient extends OpenAIClientLike> = NonStreaming<
  TClient["responses"]["create"]
>;

/**
 * A request to `responses.create` as your SDK types it.
 */
export type OpenAIRequest<TClient extends OpenAIClientLike> = Omit<
  Create<TClient>[0],
  "stream"
>;

type Reply<TClient extends OpenAIClientLike> = Create<TClient>[1];

export type OpenAIOptions<TClient extends OpenAIClientLike> = Omit<
  OpenAIRequest<TClient>,
  "input" | "tools" | "instructions"
> & {
  /**
   * Changes the whole request just before it is sent, for anything the
   * options can't say per turn: `reasoning`, trimming `input`, or
   * `tool_choice` on the last turn. Return the request.
   */
  params?: (
    request: OpenAIRequest<TClient>,
    turn: { turn: number; maxTurns: number },
  ) => OpenAIRequest<TClient>;
};

const parseArguments = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

/**
 * EXPERIMENTAL: An `AgentModel` that calls `client.responses.create()`. The
 * options are that method's own request options (`model`,
 * `max_output_tokens`, `reasoning`, ...), typed by your SDK.
 *
 * The reply's output items are kept as the API returned them, so reasoning
 * items go back untouched. OpenAI has no error flag on tool results, so a
 * failed tool's content starts with `Error: `. The SDK's own retries are off,
 * since Inngest retries the step: a 400, 401, 403, 404, 413 or 422 is not
 * retried, and a 429 or 529 waits for `retry-after`.
 *
 * @example
 * ```ts
 * import OpenAI from "openai";
 * import { agent } from "inngest/experimental";
 *
 * const gpt = agent.openai(new OpenAI(), { model: "gpt-5.1" });
 *
 * await agent.loop({ model: gpt, prompt, tools });
 * ```
 */
export const openai = <TClient extends OpenAIClientLike>(
  client: TClient,
  options: NoInfer<OpenAIOptions<TClient>>,
): AgentModel => {
  const { params, ...fixed } = options;
  const responses = client.responses as unknown as {
    create: (
      request: unknown,
      options: { maxRetries: number },
    ) => Promise<Reply<TClient>>;
  };

  return async (request) => {
    const hasTools = request.tools.length > 0;
    const body = {
      ...fixed,
      ...(request.system !== undefined && { instructions: request.system }),
      ...(hasTools && {
        tools: request.tools.map((definition) => {
          return {
            type: "function",
            name: definition.name,
            description: definition.description,
            parameters: definition.input_schema,
            strict: false,
          };
        }),
      }),
      ...(hasTools &&
        request.toolChoice && { tool_choice: request.toolChoice }),
      input: request.messages.flatMap((message) => {
        if (message.role === "user") {
          return [message];
        }

        if (message.role === "assistant") {
          return message.content as unknown[];
        }

        return message.results.map((result) => {
          return {
            type: "function_call_output",
            call_id: result.toolCallId,
            output: result.isError
              ? `Error: ${result.content}`
              : result.content,
          };
        });
      }),
    } as unknown as OpenAIRequest<TClient>;
    const sent = params
      ? params(body, { turn: request.turn, maxTurns: request.maxTurns })
      : body;

    let reply: Reply<TClient>;

    try {
      reply = await responses.create(sent, { maxRetries: 0 });
    } catch (error) {
      throw modelError(error);
    }

    const { output, usage } = reply as unknown as {
      output: {
        type: string;
        call_id: string;
        name: string;
        arguments: string;
        content: { type: string; text: string }[];
      }[];
      usage?: { input_tokens: number; output_tokens: number };
    };

    return {
      message: { role: "assistant", content: output },
      text: output
        .filter((item) => {
          return item.type === "message";
        })
        .flatMap((item) => {
          return item.content;
        })
        .filter((part) => {
          return part.type === "output_text";
        })
        .map((part) => {
          return part.text;
        })
        .join("\n"),
      toolCalls: output
        .filter((item) => {
          return item.type === "function_call";
        })
        .map((item) => {
          return {
            id: item.call_id,
            name: item.name,
            input: parseArguments(item.arguments),
          };
        }),
      usage: usage && {
        input: usage.input_tokens,
        output: usage.output_tokens,
      },
    };
  };
};
