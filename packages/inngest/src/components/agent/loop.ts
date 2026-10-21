/**
 * @module
 * EXPERIMENTAL: `agent.loop()`, a model-and-tools loop where every model call
 * is a step and every tool call is a step (or a group of steps). A run replays
 * from its memoized turns, so a crash never repeats a model call or a tool.
 *
 * The loop knows nothing about providers. You pass a `model` function that
 * calls your SDK of choice and answers in the small shape below.
 */
import { step, withSpan, withStepIdPrefix } from "../InngestStepTools.ts";
import {
  resolveToolCall,
  type SandboxTools,
  type ToolJsonDefinition,
  toolDefinitions,
} from "../sandbox/tools.ts";
import { clipContext } from "./context.ts";

/**
 * One message of the conversation. The loop keeps the `content` of an
 * `assistant` message exactly as your `model` function returned it, so
 * provider-specific parts (such as Anthropic thinking blocks and their
 * signatures) go back to the model untouched.
 */
export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: unknown }
  | { role: "tool"; results: AgentToolResult[] };

/**
 * What one tool call gave back. `content` is the result as text, and
 * `isError` is set when the tool failed. `name` and `input` are the call
 * it answers.
 */
export interface AgentToolResult {
  toolCallId: string;
  name: string;
  input: unknown;
  content: string;
  isError?: boolean;
}

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
   * format; a `tool` message holds the results of all the calls the
   * previous reply made, in one message.
   */
  messages: AgentMessage[];

  /**
   * This call's number, from 1, and the most calls the loop will make.
   */
  turn: number;
  maxTurns: number;

  /**
   * `"none"` on the last turn when the loop has a `wrapUp` text: keep
   * `tools` in the request, since the conversation uses them, but forbid
   * calling one (Anthropic: `tool_choice: { type: "none" }`).
   */
  toolChoice?: "none";

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

  /**
   * The calls the reply asks for. A reply with none is the final one.
   */
  toolCalls: AgentToolCall[];
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

  /**
   * The ID of the model call's step.
   */
  stepId: string;
  text: string;
  toolCalls: AgentToolCall[];
  usage: AgentUsage;
}

/**
 * One finished tool call. `output` is what the tool returned (the body of an
 * `agent.toolError()`, or the error message when it threw), `stepId` the ID
 * of its step (the prefix of its steps for `tool.group()`), and `ms` how long
 * the call took in this execution, which is short when it replays.
 */
export interface AgentToolRun {
  turn: number;
  call: AgentToolCall;
  output: unknown;
  isError: boolean;
  stepId: string;
  ms: number;
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
   * throws, or returns `agent.toolError(body)`, gives the model an error
   * result to react to.
   */
  tools: SandboxTools;

  /**
   * The most characters of one tool result the model sees; longer ones keep
   * their start and end. Default 8000.
   */
  maxToolOutput?: number;

  /**
   * Run the tool calls of one reply at the same time, and give the model
   * their results in the order it called them. A failure is only that call's
   * result. Set `false` to run them one after another, for tools that touch
   * the same state. Default `true`.
   */
  parallelTools?: boolean;

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
   * The text to send on the last turn (the `maxTurns`th call), with no
   * tool use allowed, so the model has to write its answer.
   */
  wrapUp?: string;

  /**
   * How much conversation to send the model on each call: old tool results are
   * shortened, oldest first, once the messages pass `maxChars` characters,
   * and the last few messages are always whole. Nothing is removed from the
   * `history` you get back. Default `{ maxChars: 200_000 }` (about 50,000
   * tokens, well inside any current model's window); `false` sends it all.
   */
  context?: { maxChars: number } | false;

  /**
   * Called when a tool call finishes, to record or show each call. It runs in
   * your function on every execution, so put side effects in steps; their IDs
   * are scoped to the call, so parallel calls don't clash.
   */
  onToolResult?: (run: AgentToolRun) => void | Promise<void>;

  /**
   * Called after each model call, for progress. It runs in your function on
   * every execution, so put side effects in steps (with IDs that include
   * `turn`) to post to Slack or a database once. An error fails the run.
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

  /**
   * Every tool call this loop made, in order.
   */
  toolCalls: AgentToolRun[];
}

const clip = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }

  const half = max / 2;

  return `${text.slice(0, half)}\n... clipped ${text.length - max} characters ...\n${text.slice(-half)}`;
};

const errorKey = "~error";

/**
 * EXPERIMENTAL: Returns a failure from a tool without throwing, so the model
 * sees an error result whose body is `body` as it is. Use it for failures the
 * model can act on; a tool that returns data with an `error` field of its own
 * is not affected.
 *
 * @example
 * ```ts
 * run: async ({ id }) => {
 *   const ticket = await db.tickets.find(id);
 *
 *   return ticket ?? agent.toolError({ message: "No such ticket", id });
 * },
 * ```
 */
const toolError = (body: unknown): { "~error": unknown } => {
  return { [errorKey]: body };
};

const isToolError = (output: unknown): output is { "~error": unknown } => {
  return typeof output === "object" && output !== null && errorKey in output;
};

const runTool = async (
  options: AgentLoopOptions & { maxToolOutput: number },
  turn: number,
  stepId: string,
  call: AgentToolCall,
): Promise<{ result: AgentToolResult; run: AgentToolRun }> => {
  const started = Date.now();
  let output: unknown;
  let isError = false;

  try {
    const input = (call.input ?? {}) as Record<string, unknown>;
    const resolved = await resolveToolCall(
      options.tools,
      { op: "call", id: 0, tool: call.name, args: [], kwargs: input },
      JSON.stringify(input),
    );

    if (resolved.error !== undefined) {
      output = resolved.error;
      isError = true;
    } else {
      const name = resolved.displayName ?? call.name;
      const span = { id: stepId, name, kind: "tool" };
      const context = {
        signal: new AbortController().signal,
        idempotencyKey: call.id,
      };
      const value = resolved.group
        ? await withSpan(span, () => {
            return withStepIdPrefix(`${stepId}:`, () => {
              return resolved.invoke(context);
            });
          })
        : await step.run({ id: stepId, name, "~span": span }, () => {
            return resolved.invoke(context);
          });

      isError = isToolError(value);
      output = isError ? (value as { [errorKey]: unknown })[errorKey] : value;
    }
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
    isError = true;
  }

  const content = typeof output === "string" ? output : JSON.stringify(output);
  const run = { turn, call, output, isError, stepId, ms: Date.now() - started };

  await withStepIdPrefix(`${stepId}:`, async () => {
    await options.onToolResult?.(run);
  });

  return {
    run,
    result: {
      toolCallId: call.id,
      name: call.name,
      input: call.input,
      content: clip(content ?? "", options.maxToolOutput),
      ...(isError && { isError }),
    },
  };
};

/**
 * EXPERIMENTAL: Runs a model with tools until it is done. Each model call is
 * one step, and each tool call is one step (a group of steps for
 * `tool.group()`).
 *
 * `model` is any function that calls a model and answers with the reply, its
 * tool calls, so any provider's SDK works.
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
  const {
    id = "agent",
    model,
    system,
    tools,
    maxTurns = 40,
    maxToolOutput = 8_000,
    parallelTools = true,
    context = { maxChars: 200_000 },
  } = options;
  const definitions = toolDefinitions(tools);
  const messages: AgentMessage[] = [
    ...(options.history ?? []),
    { role: "user", content: options.prompt },
  ];
  const usage: AgentUsage = { input: 0, output: 0 };
  const toolRuns: AgentToolRun[] = [];
  let text = "";

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const modelStep = `${id}:model:${turn}`;
    const reply = (await step.run(
      {
        id: modelStep,
        name: "Thinking",
        "~span": { id: modelStep, name: "Thinking", kind: "llm" },
      },
      () => {
        const last = turn === maxTurns && options.wrapUp !== undefined;
        const sent = context
          ? clipContext(messages, context.maxChars)
          : messages;

        return model({
          system,
          messages: last
            ? [...sent, { role: "user", content: options.wrapUp as string }]
            : sent,
          tools: definitions,
          turn,
          maxTurns,
          ...(last && { toolChoice: "none" as const }),
        });
      },
    )) as AgentModelResponse;

    usage.input += reply.usage?.input ?? 0;
    usage.output += reply.usage?.output ?? 0;
    text = reply.text ?? "";
    messages.push(reply.message);

    await options.onTurn?.({
      turn,
      stepId: modelStep,
      text,
      toolCalls: reply.toolCalls,
      usage: reply.usage ?? { input: 0, output: 0 },
    });

    if (reply.toolCalls.length === 0) {
      return {
        text,
        stopped: "done",
        turns: turn,
        history: messages,
        usage,
        toolCalls: toolRuns,
      };
    }

    const run = (call: AgentToolCall, index: number) => {
      return runTool(
        { ...options, maxToolOutput },
        turn,
        `${id}:${turn}.${index}:${call.name}`,
        call,
      );
    };
    let done: Awaited<ReturnType<typeof runTool>>[];

    if (parallelTools) {
      done = await Promise.all(reply.toolCalls.map(run));
    } else {
      done = [];

      for (const [index, call] of reply.toolCalls.entries()) {
        done.push(await run(call, index));
      }
    }

    toolRuns.push(...done.map(({ run: finished }) => finished));
    messages.push({ role: "tool", results: done.map(({ result }) => result) });

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
    toolCalls: toolRuns,
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
 *   `tool` message holds one `results` entry per call of the reply before
 *   it (`toolCallId`, `name`, `input`, `content`, and `isError` when the tool failed), ready
 *   to become one provider message.
 * - `turn` and `maxTurns`: which call this is and how many the loop allows.
 * - `toolChoice`: `"none"` on a wrap-up turn, when the model must not call a
 *   tool (keep sending `tools`, since the conversation uses them).
 * - `tools`: the tool definitions (`name`, `description`, `input_schema`) to
 *   hand to your SDK.
 *
 * It returns:
 * - `message`: the assistant's reply. The loop stores it verbatim and sends it
 *   back on every later turn, so provider-specific parts such as thinking
 *   blocks and their signatures round-trip untouched. It must be JSON.
 * - `toolCalls`: the calls the reply asks for, as `{ id, name, input }`.
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
 *           content: message.results.map((result) => {
 *             return {
 *               type: "tool_result",
 *               tool_use_id: result.toolCallId,
 *               content: result.content,
 *               is_error: result.isError,
 *             };
 *           }),
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
 *     usage: { input: reply.usage.input_tokens, output: reply.usage.output_tokens },
 *   };
 * });
 * ```
 */
const model = (fn: AgentModel): AgentModel => {
  return fn;
};

export const agent = { loop, model, toolError };
