/**
 * @module
 * EXPERIMENTAL: `anthropic()`, the one model adapter that ships with the
 * agent primitives. It answers `agent.loop()` (or a loop of your own) by calling
 * the Anthropic Messages API: prompt caching on the system prompt, the tools
 * and the growing conversation, token and cache usage, errors sorted into
 * retryable and final, and tool calls both ways. Any other provider keeps
 * implementing `AgentModel` itself.
 *
 * It depends on no package: pass your `@anthropic-ai/sdk` client, or leave it
 * out and the adapter imports the SDK the first time it is called.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { NonRetriableError } from "../NonRetriableError.ts";
import { RetryAfterError } from "../RetryAfterError.ts";
import {
  issuesMessage,
  type ToolJsonDefinition,
  toJsonSchema,
} from "../sandbox/tools.ts";
import type { AgentPriceTable } from "./cost.ts";
import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  AgentModelResponse,
  AgentToolCall,
  AgentUsage,
} from "./loop.ts";
import { classifyModelError } from "./modelErrors.ts";

/**
 * The part of an Anthropic Messages response the adapter reads. The SDK's own
 * `Message` is assignable to it.
 */
export interface AnthropicReply {
  /**
   * The reply's content blocks.
   */
  content: readonly { type: string }[];

  /**
   * Why the reply ended, such as `"end_turn"`, `"tool_use"`, `"max_tokens"` or
   * `"refusal"`.
   */
  stop_reason?: string | null;

  /**
   * Why a refusal happened, set with `stop_reason: "refusal"`.
   */
  stop_details?: {
    category?: string | null;
    explanation?: string | null;
  } | null;

  /**
   * Tokens the call used.
   */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_creation?: {
      ephemeral_1h_input_tokens?: number | null;
    } | null;
  };
}

/**
 * The part of an `@anthropic-ai/sdk` client the adapter calls, so any client
 * of the SDK (or a fake in a test) fits.
 */
export interface AnthropicClient {
  messages: {
    // biome-ignore lint/suspicious/noExplicitAny: the SDK types its own params
    create(params: any, options?: any): Promise<AnthropicReply>;
    stream?(
      // biome-ignore lint/suspicious/noExplicitAny: the SDK types its own params
      params: any,
      // biome-ignore lint/suspicious/noExplicitAny: the SDK types its own params
      options?: any,
    ): { finalMessage(): Promise<AnthropicReply> };
  };
}

/**
 * Options of `anthropic()`.
 */
export interface AnthropicOptions {
  /**
   * The model, such as `"claude-sonnet-5-5"`. It is also the name the call is
   * priced under, so use an ID that `anthropicPrices` (or your own `price`)
   * names.
   */
  model: string;

  /**
   * Your `@anthropic-ai/sdk` client. Default: the adapter makes one (reading
   * `ANTHROPIC_API_KEY`) the first time it is called, which needs the SDK
   * installed.
   */
  client?: AnthropicClient;

  /**
   * The API key of the client the adapter makes. Ignored with `client`.
   */
  apiKey?: string;

  /**
   * The base URL of the client the adapter makes. Ignored with `client`.
   */
  baseURL?: string;

  /**
   * The most tokens one reply may have, thinking included. Default 16000. A
   * reply cut off in the middle of a tool call fails the step for good, since
   * a retry would be cut off again: raise this if it happens.
   */
  maxTokens?: number;

  /**
   * How much the model thinks, sent as `output_config.effort`. Default: the
   * model's own.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";

  /**
   * The `thinking` request field, such as `{ type: "adaptive", display:
   * "summarized" }`. Default: not sent, which is the model's own default.
   * Thinking blocks and their signatures stay in the history untouched.
   */
  thinking?: Record<string, unknown>;

  /**
   * Prompt caching. A breakpoint goes on the system prompt (which caches the
   * tools with it; on the last tool when there is no system prompt), on
   * the last block of the conversation and on where the previous call's
   * conversation ended, so each call reads what the one before it wrote and
   * writes only what is new. `ttl: "1h"` keeps entries
   * for an hour (writes cost 2x instead of 1.25x), which suits long threads
   * where people answer after more than five minutes. `false` sends no
   * breakpoints. Default `{ ttl: "5m" }`.
   *
   * The loop sends the whole conversation unchanged by default, so each call
   * reads the cached prefix of the one before. Set `compaction` on
   * `agent.loop()` to summarise only near the context limit.
   */
  cache?: false | { ttl?: "5m" | "1h" };

  /**
   * Text added to the last user message after the cache breakpoint, for what
   * changes on every call (the time, a list of refs) and would otherwise
   * break the cached prefix. A function is called with each request.
   */
  volatile?:
    | string
    | ((request: AgentModelRequest) => string | undefined)
    | undefined;

  /**
   * Stream the reply and wait for the whole message, which the SDK requires
   * for a large `maxTokens`. Default: on above 21,000 `maxTokens`. Needs a
   * client with `messages.stream`.
   */
  stream?: boolean;

  /**
   * Milliseconds before a call times out. Default: 300000 on the client the
   * adapter makes, the client's own with `client`.
   */
  timeout?: number;

  /**
   * Retries inside the SDK before the step fails and Inngest retries it.
   * Default: 0 on the client the adapter makes, so every attempt is a step
   * attempt you can see; the client's own with `client`.
   */
  maxRetries?: number;

  /**
   * More fields for the request body, such as `metadata` or
   * `stop_sequences`. They are applied last.
   */
  params?: Record<string, unknown>;
}

/**
 * What can differ from one call to the next: everything in `AnthropicOptions`
 * but the client and how it is made. Changing `model`, `effort`, `thinking` or
 * `cache` for a call changes the request's cached prefix (the cache is kept
 * per model, and thinking and the cache lifetime are part of the prefix), so a
 * call that overrides them does not read what the loop's other calls wrote.
 */
export type AnthropicOverrides = Partial<
  Pick<
    AnthropicOptions,
    | "model"
    | "maxTokens"
    | "effort"
    | "thinking"
    | "cache"
    | "volatile"
    | "stream"
    | "timeout"
    | "maxRetries"
    | "params"
  >
>;

/**
 * What a direct call of the adapter takes: an `AgentModelRequest` where the
 * loop-only fields are optional, with `prompt` as a short way to write one user
 * message and `output` to ask for a structured reply.
 */
export interface AnthropicCall {
  /**
   * The system prompt. Keep it stable between calls: changing it changes the
   * start of the cached prefix. Put what changes in `volatile`.
   */
  system?: string;

  /**
   * The conversation. Default: one user message with `prompt`.
   */
  messages?: AgentMessage[];

  /**
   * One user message, when you have no `messages`.
   */
  prompt?: string;

  /**
   * Tools the model may call, in the shape of `toolDefinitions()`. Default none.
   */
  tools?: ToolJsonDefinition[];

  /**
   * `"none"` keeps `tools` in the request but forbids calling one. `{ name }`
   * asks for a call of that tool: the request stays on `auto` (the newest
   * models refuse a forced `tool_choice`) and the text after the cached prefix
   * says to reply only by calling it.
   */
  toolChoice?: "none" | { name: string };

  /**
   * A schema (Zod 4, or any library with Standard JSON Schema) for a
   * structured reply. The model is given one tool, `respond`, and told to reply
   * only by calling it; the call's input is validated and returned as `output`,
   * typed by the schema, and `toolCalls` is empty. A reply that is not a valid
   * call fails the step, which Inngest retries. The schema describes an object.
   */
  output?: StandardSchemaV1;

  /**
   * The call's number, given to a `volatile` function. Default 1.
   */
  turn?: number;

  /**
   * The loop's last turn, given to a `volatile` function. Default 1.
   */
  maxTurns?: number;
}

/**
 * The reply of a direct call with an `output` schema: the usual response and
 * the validated structured reply.
 */
export type AnthropicOutputResponse<TOutput extends StandardSchemaV1> =
  AgentModelResponse & { output: StandardSchemaV1.InferOutput<TOutput> };

/**
 * The model `anthropic()` returns. Hand it to `agent.loop({ model })` as it is,
 * or call it inside a `step.run` for a single reply.
 */
export interface AnthropicModel {
  /**
   * One reply with a structured `output`.
   */
  <TOutput extends StandardSchemaV1>(
    call: AnthropicCall & { output: TOutput },
  ): Promise<AnthropicOutputResponse<TOutput>>;

  /**
   * One reply.
   */
  (call: AnthropicCall): Promise<AgentModelResponse>;

  /**
   * The same model with some options changed, sharing the client, such as
   * `claude.with({ effort: "low", maxTokens: 50 })`. An override replaces the
   * option (`params` merges into it), and `undefined` clears one.
   * @param overrides The options to change.
   */
  with(overrides: AnthropicOverrides): AnthropicModel;
}

type Block = { type: string } & Record<string, unknown>;
type Param = { role: "user" | "assistant"; content: Block[] };

/**
 * USD per million tokens for the current Claude models, in the shape
 * `limits.price` and `agent.loop({ price })` take. The SDK keeps this list
 * for convenience and Anthropic can change a price; spread it and add or
 * replace an entry to override. Haiku 5.5 is priced at its rate for prompts up
 * to 100,000 tokens.
 *
 * @example
 * ```ts
 * limits: { price: { ...anthropicPrices, "claude-x": { input: 1, output: 5 } } }
 * ```
 */
export const anthropicPrices: AgentPriceTable = (() => {
  // Cache writes cost 1.25x the input rate for five minutes and 2x for an
  // hour. Cache reads cost 0.1x, except where the model's page says otherwise.
  const rate = (input: number, output: number, cacheRead = input / 10) => {
    return {
      input,
      output,
      cacheRead,
      cacheWrite: input * 1.25,
      cacheWrite1h: input * 2,
    };
  };

  return {
    "claude-fable-5-1": rate(10, 50, 0.25),
    "claude-mythos-5-1": rate(10, 50, 0.25),
    "claude-fable-5": rate(10, 50),
    "claude-opus-5-5": rate(4, 20, 0.2),
    "claude-opus-5": rate(5, 25),
    "claude-opus-4-8": rate(5, 25),
    "claude-opus-4-7": rate(5, 25),
    "claude-opus-4-6": rate(5, 25),
    "claude-sonnet-5-5": rate(2, 10),
    "claude-sonnet-5": rate(2, 10),
    "claude-sonnet-4-6": rate(3, 15),
    "claude-haiku-5-5": rate(0.1, 0.5),
    "claude-haiku-4-5": rate(1, 5),
  };
})();

const defaultMaxTokens = 16_000;

/**
 * Above this many output tokens the SDK refuses a request that is not
 * streamed, because it could run past ten minutes.
 */
const streamAbove = 21_000;

const textBlock = (text: string): Block => {
  return { type: "text", text };
};

/**
 * A block of a reply, cut down to the fields the API takes back, so the
 * history stays small and plain JSON. A block of a kind this does not know
 * (such as a server tool's) is kept as it is.
 */
const keepBlock = (block: Block): Block => {
  switch (block.type) {
    case "text": {
      return textBlock(block.text as string);
    }
    case "thinking": {
      return {
        type: "thinking",
        thinking: block.thinking,
        signature: block.signature,
      };
    }
    case "redacted_thinking": {
      return { type: "redacted_thinking", data: block.data };
    }
    case "tool_use": {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    default: {
      return block;
    }
  }
};

/**
 * The loop's messages as Anthropic's. Tool results become `tool_result` blocks
 * of a user message, and neighbours of the same role are joined into one
 * message, since the API reads them as one turn anyway. Tool results stay
 * first in their message.
 */
const toParams = (messages: AgentMessage[]): Param[] => {
  const params: Param[] = [];

  const add = (role: Param["role"], blocks: Block[]) => {
    const last = params[params.length - 1];

    if (last?.role === role) {
      last.content.push(...blocks);

      return;
    }

    params.push({ role, content: blocks });
  };

  for (const message of messages) {
    if (message.role === "user") {
      add(
        "user",
        typeof message.content === "string"
          ? [textBlock(message.content)]
          : [...(message.content as Block[])],
      );
    } else if (message.role === "tool") {
      add(
        "user",
        message.results.map((result) => {
          return {
            type: "tool_result",
            tool_use_id: result.toolCallId,
            content: result.content === "" ? "(no output)" : result.content,
            ...(result.isError && { is_error: true }),
          };
        }),
      );
    } else {
      const content =
        typeof message.content === "string"
          ? [textBlock(message.content)]
          : [...(message.content as Block[])];

      // The API refuses an assistant message with no content.
      add(
        "assistant",
        content.length > 0 ? content : [textBlock("(no reply)")],
      );
    }
  }

  return params;
};

const withCacheControl = <T extends object>(
  block: T,
  control: Record<string, unknown>,
): T => {
  return { ...block, cache_control: control };
};

/**
 * Adds the volatile text after the last block, and the cache breakpoint on the
 * last block before it, so the text never changes the cached prefix.
 */
const withTail = (
  input: Param[],
  control: Record<string, unknown> | undefined,
  volatile: string | undefined,
): Param[] => {
  let params = input;
  const last = params[params.length - 1];

  if (!last) {
    return params;
  }

  // A breakpoint finds an earlier entry only within about 20 blocks behind it,
  // and one turn of parallel tool calls can add more. A second breakpoint where
  // the previous call's conversation ended keeps that entry in reach.
  let before = params.length - 2;

  while (before >= 0 && params[before]?.role !== "assistant") {
    before -= 1;
  }

  if (control && before >= 1) {
    const prior = params[before - 1] as Param;
    const content = prior.content.slice();

    content[content.length - 1] = withCacheControl(
      content[content.length - 1] as Block,
      control,
    );
    params = params.map((param, index) => {
      return index === before - 1 ? { ...param, content } : param;
    });
  }

  const body = last.content.slice();
  const tail = body[body.length - 1] as Block;

  // Thinking blocks can't carry a breakpoint, and only an assistant message
  // can end with one.
  if (control && !tail.type.endsWith("thinking")) {
    body[body.length - 1] = withCacheControl(tail, control);
  }

  if (volatile && last.role === "user") {
    body.push(textBlock(volatile));
  }

  const out = [...params.slice(0, -1), { role: last.role, content: body }];

  return volatile && last.role === "assistant"
    ? [...out, { role: "user", content: [textBlock(volatile)] }]
    : out;
};

const outputToolName = "respond";

/**
 * The tool that carries a structured reply, from the schema of `output`.
 */
const outputTool = (schema: StandardSchemaV1): ToolJsonDefinition => {
  return {
    name: outputToolName,
    description:
      "Give your reply by calling this tool once. Its input is the reply.",
    input_schema: toJsonSchema(outputToolName, schema),
  };
};

/**
 * The Messages API request for one call.
 */
const buildBody = (
  options: AnthropicOptions,
  call: AnthropicCall,
): Record<string, unknown> => {
  const ttl =
    options.cache === false ? undefined : (options.cache?.ttl ?? "5m");
  const control = ttl
    ? { type: "ephemeral", ...(ttl === "1h" && { ttl }) }
    : undefined;
  if (call.messages === undefined && call.prompt === undefined) {
    throw new NonRetriableError("anthropic() needs `messages` or `prompt`");
  }

  if (call.output && call.toolChoice === "none") {
    throw new NonRetriableError(
      'anthropic() can not ask for an `output` with `toolChoice: "none"`: the reply is a tool call',
    );
  }

  if (
    call.output &&
    call.tools?.some((tool) => {
      return tool.name === outputToolName;
    })
  ) {
    throw new NonRetriableError(
      `anthropic() uses a tool named  for \`output\`: rename yours`,
    );
  }

  if (
    typeof call.toolChoice === "object" &&
    !call.tools?.some((tool) => {
      return tool.name === (call.toolChoice as { name: string }).name;
    })
  ) {
    throw new NonRetriableError(
      `anthropic() was asked for the tool , which is not in \`tools\``,
    );
  }

  const messages: AgentMessage[] = call.messages ?? [
    { role: "user", content: call.prompt as string },
  ];
  const request: AgentModelRequest = {
    system: call.system,
    messages,
    tools: call.tools ?? [],
    turn: call.turn ?? 1,
    maxTurns: call.maxTurns ?? 1,
    ...(call.toolChoice === "none" && { toolChoice: "none" as const }),
  };
  const named =
    call.output !== undefined
      ? outputToolName
      : typeof call.toolChoice === "object"
        ? call.toolChoice.name
        : undefined;
  // After the breakpoint, so asking for a tool never changes the cached prefix.
  const volatile =
    [
      typeof options.volatile === "function"
        ? options.volatile(request)
        : options.volatile,
      named &&
        `Reply only by calling the \`${named}\` tool, once. Write no text.`,
    ]
      .filter(Boolean)
      .join("\n\n") || undefined;
  const listed = call.output
    ? [...request.tools, outputTool(call.output)]
    : request.tools;
  const tools =
    listed.length > 0
      ? listed.map((tool, index) => {
          // With no system prompt to carry it, the last tool carries the
          // breakpoint that caches the tools.
          return control && !request.system && index === listed.length - 1
            ? withCacheControl(tool, control)
            : tool;
        })
      : undefined;

  return {
    model: options.model,
    max_tokens: options.maxTokens ?? defaultMaxTokens,
    ...(request.system && {
      system: [
        {
          ...textBlock(request.system),
          ...(control && { cache_control: control }),
        },
      ],
    }),
    ...(tools && { tools }),
    ...(tools &&
      request.toolChoice === "none" && {
        tool_choice: { type: "none" },
      }),
    ...(options.thinking && { thinking: options.thinking }),
    ...(options.effort && { output_config: { effort: options.effort } }),
    messages: withTail(toParams(request.messages), control, volatile),
    ...options.params,
  };
};

const usageOf = (reply: AnthropicReply): AgentUsage => {
  const used = reply.usage;
  const read = used.cache_read_input_tokens ?? 0;
  const written = used.cache_creation_input_tokens ?? 0;
  const written1h = used.cache_creation?.ephemeral_1h_input_tokens ?? 0;

  // `input_tokens` counts only what comes after the last breakpoint.
  return {
    input: used.input_tokens + read + written,
    output: used.output_tokens,
    cacheRead: read,
    cacheWrite: written,
    cacheWrite1h: written1h,
  };
};

const parse = (options: AnthropicOptions, reply: AnthropicReply) => {
  // An empty text block is refused when it is sent back.
  const blocks = (reply.content as Block[])
    .filter((block) => {
      return block.type !== "text" || block.text !== "";
    })
    .map(keepBlock);
  const toolCalls: AgentToolCall[] = blocks.flatMap((block) => {
    return block.type === "tool_use"
      ? [
          {
            id: block.id as string,
            name: block.name as string,
            input: block.input,
          },
        ]
      : [];
  });

  if (reply.stop_reason === "refusal") {
    const { category, explanation } = reply.stop_details ?? {};

    throw new NonRetriableError(
      `${options.model} refused the request${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : ""}`,
    );
  }

  // A retry would stop in the same place, and a loop that took a cut-off
  // reply for an answer would end with half of one.
  if (reply.stop_reason === "max_tokens") {
    throw new NonRetriableError(
      `${options.model} reached maxTokens (${options.maxTokens ?? defaultMaxTokens}) before it finished its reply; raise maxTokens`,
    );
  }

  if (
    reply.stop_reason === "model_context_window_exceeded" ||
    reply.stop_reason === "pause_turn"
  ) {
    throw new NonRetriableError(
      `${options.model} stopped with ${reply.stop_reason}, which anthropic() does not handle`,
    );
  }

  const text = blocks
    .flatMap((block) => {
      return block.type === "text" ? [block.text as string] : [];
    })
    .join("");

  return { blocks, toolCalls, text };
};

/**
 * Seconds-to-milliseconds of the `retry-after` header an API error carries, so
 * the step retries when the API asked rather than on Inngest's own schedule.
 */
const retryAfterMs = (error: unknown): number | undefined => {
  const headers = (error as { headers?: unknown } | null)?.headers as
    | { get?: (name: string) => string | null }
    | Record<string, string>
    | undefined;
  const read = (name: string): string | null | undefined => {
    return typeof (headers as { get?: unknown })?.get === "function"
      ? (headers as { get: (name: string) => string | null }).get(name)
      : (headers as Record<string, string> | undefined)?.[name];
  };
  const ms = Number(read("retry-after-ms"));
  const seconds = Number(read("retry-after"));

  if (Number.isFinite(ms) && ms > 0) {
    return ms;
  }

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};

/**
 * Sorts an error from the SDK: a final one becomes a `NonRetriableError`,
 * and a retryable one that names a wait (a 429's `retry-after`) a
 * `RetryAfterError`, so the step retries when the API said it could.
 */
const sortError = (error: unknown): unknown => {
  const sorted = classifyModelError(error);

  if (sorted instanceof NonRetriableError) {
    return sorted;
  }

  const wait = retryAfterMs(error);

  return wait === undefined
    ? sorted
    : new RetryAfterError(
        error instanceof Error ? error.message : String(error),
        wait,
        { cause: error },
      );
};

type SdkConstructor = new (options: Record<string, unknown>) => AnthropicClient;

const importClient = async (
  options: AnthropicOptions,
): Promise<AnthropicClient> => {
  const name = "@anthropic-ai/sdk";
  let mod: { default?: SdkConstructor; Anthropic?: SdkConstructor };

  try {
    mod = await import(name);
  } catch (cause) {
    throw new NonRetriableError(
      `anthropic() could not import @anthropic-ai/sdk (${cause instanceof Error ? cause.message : String(cause)}): install it, or pass your client as \`client\`, which a bundled app must do`,
      { cause },
    );
  }

  const Anthropic = mod.default ?? mod.Anthropic;

  if (!Anthropic) {
    throw new NonRetriableError(
      "@anthropic-ai/sdk has no client class to construct: pass your client as `client`",
    );
  }

  return new Anthropic({
    timeout: options.timeout ?? 300_000,
    maxRetries: options.maxRetries ?? 0,
    ...(options.apiKey && { apiKey: options.apiKey }),
    ...(options.baseURL && { baseURL: options.baseURL }),
  });
};

/**
 * EXPERIMENTAL: A model for `agent.loop()` that calls the Anthropic Messages
 * API. The loop runs it inside one step per call, and a loop of your own can
 * call the returned function inside a plain `step.run`. It never uses
 * `step.ai`.
 *
 * - Prompt caching is on: breakpoints on the system prompt (with the tools)
 *   and on the end of the conversation. `usage` reports `cacheRead` and
 *   `cacheWrite` next to `input` and `output`, and `anthropicPrices` prices
 *   them.
 * - A 400 (or 401, 403, 404 and so on) fails the step for good; a 429, 529 or
 *   5xx is retried, after the `retry-after` the API sent when it sent one.
 *   A refusal and a reply cut off by `maxTokens` also fail it for good.
 * - Parallel tool calls come back as `toolCalls`, and the loop's tool results
 *   go back as one user message of `tool_result` blocks.
 *
 * A bundled app (webpack, Next) can't import the SDK when `client` is left
 * out: pass `client`. A conversation with tool calls in its history needs
 * `tools` in each request, so a tool-less loop can't continue one.
 *
 * Keep the loop's `system` string stable: it starts the cached prefix, so a
 * system prompt that changes between calls misses the cache on every one. Put
 * what changes (the time, a list of refs) in `volatile`, which goes after the
 * breakpoint.
 *
 * `claude.with({ model, effort, maxTokens, ... })` is the same model with other
 * options, for one loop or one call, and calling `claude({ prompt, output })`
 * inside a `step.run` makes a single reply, with `output` (a schema) for a
 * structured one. See `AnthropicOverrides` for what an override does to the
 * cache.
 *
 * Not covered: forcing one tool (`tool_choice` `any` or `tool`, which the
 * newest models refuse anyway; `toolChoice: { name }` on a direct call asks in
 * words instead) and server tools, which you can still add through `params`.
 *
 * @example
 * ```ts
 * import Anthropic from "@anthropic-ai/sdk";
 * import { agent, anthropicPrices } from "inngest/experimental/agents";
 *
 * const claude = agent.anthropic({
 *   model: "claude-sonnet-5-5",
 *   client: new Anthropic(),
 *   cache: { ttl: "1h" },
 * });
 *
 * const { text, usage } = await agent.loop({
 *   model: claude,
 *   prompt: "Fix the failing test",
 *   tools: sandbox.tools.code(),
 *   price: anthropicPrices,
 * });
 *
 * // One structured reply, outside any loop.
 * const { output } = await step.run("triage", async () => {
 *   return claude.with({ maxTokens: 2000 })({
 *     system: "Triage the ticket.",
 *     prompt: ticket,
 *     output: z.object({ investigate: z.boolean(), reason: z.string() }),
 *   });
 * });
 * ```
 */
export const anthropic = (options: AnthropicOptions): AnthropicModel => {
  // Shared by every `with()` of this adapter, so the SDK is imported once.
  const shared: { client?: AnthropicClient } = { client: options.client };

  const make = (current: AnthropicOptions): AnthropicModel => {
    const requestOptions = {
      ...(current.timeout !== undefined && { timeout: current.timeout }),
      ...(current.maxRetries !== undefined && {
        maxRetries: current.maxRetries,
      }),
    };
    const streaming =
      current.stream ?? (current.maxTokens ?? defaultMaxTokens) > streamAbove;

    const call = async (given: AnthropicCall): Promise<AgentModelResponse> => {
      let reply: AnthropicReply;

      try {
        shared.client ??= await importClient(options);

        const body = buildBody(current, given);

        if (streaming) {
          if (!shared.client.messages.stream) {
            throw new NonRetriableError(
              "anthropic() needs a client with messages.stream for this maxTokens",
            );
          }

          reply = await shared.client.messages
            .stream(body, requestOptions)
            .finalMessage();
        } else {
          reply = await shared.client.messages.create(body, requestOptions);
        }
      } catch (error) {
        throw sortError(error);
      }

      const { blocks, toolCalls, text } = parse(current, reply);
      const response: AgentModelResponse = {
        message: { role: "assistant", content: blocks },
        text,
        toolCalls,
        usage: usageOf(reply),
        model: current.model,
      };

      if (!given.output) {
        return response;
      }

      const used = toolCalls.find((toolCall) => {
        return toolCall.name === outputToolName;
      });

      if (!used) {
        throw new Error(
          `${current.model} did not reply by calling the ${outputToolName} tool`,
        );
      }

      const checked = await given.output["~standard"].validate(used.input);

      if (checked.issues) {
        throw new Error(
          `${current.model}'s reply does not match the output schema: ${issuesMessage(checked.issues)}`,
        );
      }

      return { ...response, toolCalls: [], output: checked.value } as never;
    };

    return Object.assign(call, {
      with: (overrides: AnthropicOverrides) => {
        return make({
          ...current,
          ...overrides,
          model: overrides.model ?? current.model,
          params:
            "params" in overrides && overrides.params === undefined
              ? undefined
              : { ...current.params, ...overrides.params },
        });
      },
    }) as AnthropicModel;
  };

  return make(options);
};
