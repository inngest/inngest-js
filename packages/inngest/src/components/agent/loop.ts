/**
 * @module
 * EXPERIMENTAL: `agent.loop()`, a model-and-tools loop where every model call
 * is a step and every tool call is a step (or a group of steps). A run replays
 * from its memoized turns, so a crash never repeats a model call or a tool.
 *
 * The loop knows nothing about providers. You pass a `model` function that
 * calls your SDK of choice and answers in the small shape below.
 */
import { step } from "../InngestStepTools.ts";
import {
  resolveToolCall,
  type SandboxTools,
  type ToolJsonDefinition,
  toolDefinitions,
} from "../sandbox/tools.ts";

/**
 * One message of the conversation. The loop keeps the `content` of an
 * `assistant` message exactly as your `model` function returned it, so
 * provider-specific parts (such as Anthropic thinking blocks and their
 * signatures) go back to the model untouched.
 */
export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: unknown }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentUsage {
  input: number;
  output: number;
}

export interface AgentModelRequest {
  system?: string;

  /**
   * The whole conversation so far. Map each message to your provider's
   * format; a `tool` message is the result of the call with `toolCallId`.
   */
  messages: AgentMessage[];

  /**
   * The tools in the shape model APIs take. Pass them straight to your SDK.
   */
  tools: ToolJsonDefinition[];
}

export interface AgentModelResponse {
  /**
   * The assistant's reply, kept in the history as it is.
   */
  message: Extract<AgentMessage, { role: "assistant" }>;

  /**
   * The reply's text, for the final result and `onTurn`.
   */
  text?: string;
  toolCalls: AgentToolCall[];

  /**
   * Whether the model has finished. The loop also stops when there are no
   * tool calls.
   */
  done: boolean;
  usage?: AgentUsage;
}

/**
 * Calls a model once. It runs inside a step, so a failure is retried: throw a
 * `NonRetriableError` when a retry can't help, such as a bad request.
 */
export type AgentModel = (
  request: AgentModelRequest,
) => Promise<AgentModelResponse>;

export interface AgentTurn {
  turn: number;
  text: string;
  toolCalls: AgentToolCall[];
  usage: AgentUsage;
}

export interface AgentLoopOptions {
  /**
   * Prefix of the step IDs. Default `"agent"`.
   */
  id?: string;
  model: AgentModel;
  system?: string;

  /**
   * The first user message.
   */
  prompt: string;

  /**
   * Tools the model can call, declared like sandbox tools. A tool that
   * throws gives the model an error result to react to.
   */
  tools: SandboxTools;

  /**
   * The most model calls to make. Default 40.
   */
  maxTurns?: number;

  /**
   * The `history` of an earlier result, to continue its conversation.
   */
  history?: AgentMessage[];

  /**
   * Called between model calls, after the tool results. Returned strings reach
   * the model as user messages, so a person can redirect a long task. It runs
   * in your function, so it can use steps to read a durable log.
   */
  steer?: (turn: number) => Promise<string[] | undefined>;

  /**
   * Called inside each model step as it finishes, for progress. Errors are
   * ignored.
   */
  onTurn?: (turn: AgentTurn) => void | Promise<void>;
}

export interface AgentLoopResult {
  /**
   * The text of the last model reply.
   */
  text: string;
  stopped: "done" | "maxTurns";
  turns: number;

  /**
   * The whole conversation. Pass it as `history` to continue.
   */
  history: AgentMessage[];
  usage: AgentUsage;
}

const maxToolOutput = 8_000;

const clip = (text: string): string => {
  if (text.length <= maxToolOutput) {
    return text;
  }

  const half = maxToolOutput / 2;

  return `${text.slice(0, half)}\n... clipped ${text.length - maxToolOutput} characters ...\n${text.slice(-half)}`;
};

const runTool = async (
  stepId: string,
  tools: SandboxTools,
  call: AgentToolCall,
): Promise<Extract<AgentMessage, { role: "tool" }>> => {
  const result = (content: string, isError?: boolean) => {
    return {
      role: "tool" as const,
      toolCallId: call.id,
      content: clip(content),
      ...(isError && { isError }),
    };
  };

  try {
    const input = (call.input ?? {}) as Record<string, unknown>;
    const resolved = await resolveToolCall(
      tools,
      { op: "call", id: 0, tool: call.name, args: [], kwargs: input },
      JSON.stringify(input),
    );

    if (resolved.error !== undefined) {
      return result(resolved.error, true);
    }

    const context = {
      signal: new AbortController().signal,
      idempotencyKey: call.id,
    };
    const output = resolved.group
      ? await resolved.invoke(context)
      : await step.run({ id: stepId, name: call.name }, () => {
          return resolved.invoke(context);
        });

    return result(
      typeof output === "string" ? output : (JSON.stringify(output) ?? ""),
    );
  } catch (error) {
    return result(error instanceof Error ? error.message : String(error), true);
  }
};

/**
 * EXPERIMENTAL: Runs a model with tools until it is done. Each model call is
 * one step, and each tool call is one step (a group of steps for
 * `tool.group()`).
 *
 * `model` is any function that calls a model and answers with the reply, its
 * tool calls and whether it is done, so any provider's SDK works.
 *
 * @example
 * ```ts
 * import { agent, codeTools } from "inngest/experimental";
 *
 * const { text } = await agent.loop({
 *   model: claude, // see `agent.model()`
 *   prompt: "Fix the failing test",
 *   tools: codeTools(sandbox),
 * });
 * ```
 */
const loop = async (options: AgentLoopOptions): Promise<AgentLoopResult> => {
  const { id = "agent", model, system, tools, maxTurns = 40 } = options;
  const definitions = toolDefinitions(tools);
  const messages: AgentMessage[] = [
    ...(options.history ?? []),
    { role: "user", content: options.prompt },
  ];
  const usage: AgentUsage = { input: 0, output: 0 };
  let text = "";

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const reply = (await step.run(
      { id: `${id}:model:${turn}`, name: "Thinking" },
      async () => {
        const response = await model({ system, messages, tools: definitions });

        try {
          await options.onTurn?.({
            turn,
            text: response.text ?? "",
            toolCalls: response.toolCalls,
            usage: response.usage ?? { input: 0, output: 0 },
          });
        } catch {
          // Progress reporting never fails the turn.
        }

        return response;
      },
    )) as AgentModelResponse;

    usage.input += reply.usage?.input ?? 0;
    usage.output += reply.usage?.output ?? 0;
    text = reply.text ?? "";
    messages.push(reply.message);

    if (reply.done || reply.toolCalls.length === 0) {
      return { text, stopped: "done", turns: turn, history: messages, usage };
    }

    for (const [index, call] of reply.toolCalls.entries()) {
      messages.push(
        await runTool(`${id}:${turn}.${index}:${call.name}`, tools, call),
      );
    }

    for (const content of (await options.steer?.(turn)) ?? []) {
      messages.push({ role: "user", content });
    }
  }

  return {
    text,
    stopped: "maxTurns",
    turns: maxTurns,
    history: messages,
    usage,
  };
};

/**
 * EXPERIMENTAL: Types a model function for `agent.loop()`. It returns the
 * function it is given and does nothing else.
 *
 * Your function is called once per turn, inside a step, with:
 * - `system`: the system prompt, if you passed one.
 * - `messages`: the conversation so far. `user` messages are text. An
 *   `assistant` message is what you returned earlier, as you returned it. A
 *   `tool` message is the result of the call with `toolCallId`, and has
 *   `isError` when the tool failed; map consecutive ones to your provider's
 *   tool-result format.
 * - `tools`: the tool definitions (`name`, `description`, `input_schema`) to
 *   hand to your SDK.
 *
 * It returns:
 * - `message`: the assistant's reply. The loop stores it verbatim and sends it
 *   back on every later turn, so provider-specific parts such as thinking
 *   blocks and their signatures round-trip untouched. It must be JSON.
 * - `toolCalls`: the calls the reply asks for, as `{ id, name, input }`.
 * - `done`: whether the model has finished.
 * - `text`: the reply's text, for the result and `onTurn`.
 * - `usage`: tokens, which the loop adds up.
 *
 * @example
 * ```ts
 * import Anthropic from "@anthropic-ai/sdk";
 * import { agent } from "inngest/experimental";
 *
 * const anthropic = new Anthropic();
 *
 * export const claude = agent.model(async ({ system, messages, tools }) => {
 *   const reply = await anthropic.messages.create({
 *     model: "claude-sonnet-5-5",
 *     max_tokens: 8192,
 *     system,
 *     tools,
 *     messages: messages.map((message) => {
 *       if (message.role === "tool") {
 *         return {
 *           role: "user",
 *           content: [
 *             {
 *               type: "tool_result",
 *               tool_use_id: message.toolCallId,
 *               content: message.content,
 *               is_error: message.isError,
 *             },
 *           ],
 *         };
 *       }
 *
 *       return message;
 *     }),
 *   });
 *
 *   return {
 *     message: { role: "assistant", content: reply.content },
 *     text: reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
 *     toolCalls: reply.content.flatMap((b) => (b.type === "tool_use" ? [b] : [])),
 *     done: reply.stop_reason !== "tool_use",
 *     usage: { input: reply.usage.input_tokens, output: reply.usage.output_tokens },
 *   };
 * });
 * ```
 */
const model = (fn: AgentModel): AgentModel => {
  return fn;
};

export const agent = { loop, model };
