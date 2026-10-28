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
  type ToolInputType,
  type ToolJsonDefinition,
  type ToolOutputType,
  toolDefinitions,
} from "../sandbox/tools.ts";
import { clipContext } from "./context.ts";
import { invoke } from "./invoke.ts";

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
  /**
   * The ID of the call this answers.
   */
  toolCallId: string;

  /**
   * The tool's name.
   */
  name: string;

  /**
   * The arguments of the call, as the model sent them.
   */
  input: unknown;

  /**
   * The result as text.
   */
  content: string;

  /**
   * Set when the tool failed.
   */
  isError?: boolean;
}

// The default for the tools a loop's runs and result were given. `any` is
// what lets a result typed for its own tools be assigned to a plain
// `AgentLoopResult` or `AgentToolRun`: `keyof TTools` makes the compiler treat
// the parameter as invariant, and `any` is the one argument that goes both
// ways. Its runs have `unknown` input and output, as untyped tools should.
// `AgentLoopOptions` keeps `SandboxTools` as its default so that plain options
// still check their `tools`; a typed one is not assignable to it.
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyTools = any;

/**
 * A tool call the model asked for.
 */
export interface AgentToolCall<
  TName extends string = string,
  TInput = unknown,
> {
  /**
   * The provider's ID of the call; the result answers it.
   */
  id: string;

  /**
   * The tool's name in the model's list.
   */
  name: TName;

  /**
   * The arguments the model sent. Untrusted JSON until the tool's schema has
   * checked it, so it is `unknown` unless the run did not fail.
   */
  input: TInput;
}

/**
 * Tokens used by model calls.
 */
export interface AgentUsage {
  /**
   * Input tokens.
   */
  input: number;

  /**
   * Output tokens.
   */
  output: number;
}

/**
 * What the loop hands to your `model` function for one call.
 */
export interface AgentModelRequest {
  /**
   * The system prompt, if the loop has one.
   */
  system?: string;

  /**
   * The whole conversation so far. Map each message to your provider's
   * format; a `tool` message holds the results of all the calls the
   * previous reply made, in one message.
   */
  messages: AgentMessage[];

  /**
   * This call's number, from 1.
   */
  turn: number;

  /**
   * The most model calls the loop will make.
   */
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

/**
 * What your `model` function answers with: the reply, its text, the tool calls
 * it asks for and the tokens it used.
 */
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

  /**
   * Tokens this call used, which the loop adds up. Default: none counted.
   */
  usage?: AgentUsage;
}

/**
 * Calls a model once. It runs inside a step, so a failure is retried: throw a
 * `NonRetriableError` when a retry can't help, such as a bad request.
 */
export type AgentModel = (
  request: AgentModelRequest,
) => Promise<AgentModelResponse>;

/**
 * One finished model call, as `onTurn` receives it.
 */
export interface AgentTurn {
  /**
   * This call's number, from 1.
   */
  turn: number;

  /**
   * The ID of the model call's step.
   */
  stepId: string;

  /**
   * The reply's text.
   */
  text: string;

  /**
   * The calls the reply asked for.
   */
  toolCalls: AgentToolCall[];

  /**
   * Tokens this call used.
   */
  usage: AgentUsage;
}

/**
 * One finished tool call. `output` is what the tool returned (the body of an
 * `agent.toolError()`, or the error message when it threw), `stepId` the ID
 * of its step (the prefix of its steps for `tool.group()`), and `ms` how long
 * the call took in this execution, which is short when it replays.
 *
 * With typed `tools`, once `isError` is false, checking `name` narrows
 * `call.input` and `output` to what that tool declares. A failed run is not
 * narrowed: the model may have named a tool you don't have or passed input
 * that doesn't fit, so its `name` is any string and its `call.input` unknown.
 */
export type AgentToolRun<TTools extends SandboxTools = AnyTools> =
  | {
      [TName in keyof TTools & string]: AgentToolRunOf<
        TName,
        ToolInputType<TTools[TName]>,
        false,
        ToolOutputType<TTools[TName]>
      >;
    }[keyof TTools & string]
  | AgentToolRunOf<string, unknown, true, unknown>;

interface AgentToolRunOf<
  TName extends string,
  TInput,
  TIsError extends boolean,
  TOutput,
> {
  /**
   * The model call that asked for it.
   */
  turn: number;

  /**
   * The tool's name, the same as `call.name`, on the run itself so that
   * checking it narrows `call.input` and `output`.
   */
  name: TName;

  /**
   * The call.
   */
  call: AgentToolCall<TName, TInput>;

  /**
   * What the tool returned.
   */
  output: TOutput;

  /**
   * Whether the call failed.
   */
  isError: TIsError;

  /**
   * The ID of the call's step.
   */
  stepId: string;

  /**
   * How long the call took in this execution.
   */
  ms: number;
}

/**
 * Options of `agent.loop()`.
 */
export interface AgentLoopOptions<TTools extends SandboxTools = SandboxTools> {
  /**
   * Prefix of the step IDs. Default `"agent"`.
   */
  id?: string;

  /**
   * Calls your model once per turn. Make it with `agent.model()`.
   */
  model: AgentModel;

  /**
   * The system prompt. Default: none.
   */
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
  tools: TTools;

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
   * Called between model calls, after `steer`. Return `true` to end the loop
   * early with `stopped: "stopped"`. It runs in your function, so it can use
   * steps to read a durable flag.
   */
  stop?: (turn: number) => Promise<boolean>;

  /**
   * Called before each model call. Return a reason to end the loop with
   * `stopped: "budget"` and that `reason`, as `control.budget` does when the
   * agent's `limits.budget` is spent.
   */
  budget?: (turn: number) => string | undefined | Promise<string | undefined>;

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
  onToolResult?: (run: AgentToolRun<TTools>) => void | Promise<void>;

  /**
   * Called after each model call, for progress. It runs in your function on
   * every execution, so put side effects in steps (with IDs that include
   * `turn`) to post to Slack or a database once. An error fails the run.
   */
  onTurn?: (turn: AgentTurn) => void | Promise<void>;
}

/**
 * What `agent.loop()` returns.
 */
export interface AgentLoopResult<TTools extends SandboxTools = AnyTools> {
  /**
   * The text of the last model reply.
   */
  text: string;

  /**
   * Why the loop ended: the model finished (`"done"`), it ran out of turns,
   * `stop` asked to end it, or the budget was spent.
   */
  stopped: "done" | "maxTurns" | "stopped" | "budget";

  /**
   * Why the loop ended, for `stopped: "budget"`.
   */
  reason?: string;

  /**
   * How many model calls the loop made.
   */
  turns: number;

  /**
   * The whole conversation. Pass it as `history` to continue.
   */
  history: AgentMessage[];

  /**
   * Tokens used by every model call of this loop.
   */
  usage: AgentUsage;

  /**
   * Every tool call this loop made, in order.
   */
  toolCalls: AgentToolRun<TTools>[];
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

const runTool = async <TTools extends SandboxTools>(
  options: AgentLoopOptions<TTools> & { maxToolOutput: number },
  turn: number,
  stepId: string,
  call: AgentToolCall,
): Promise<{ result: AgentToolResult; run: AgentToolRun<TTools> }> => {
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
  // The model names the tool and the input at run time, so the compiler can't
  // connect them to `TTools`. The type promises the narrowing only for runs
  // that did not fail, and those ran a tool of that name with its input.
  const run = {
    turn,
    name: call.name,
    call,
    output,
    isError,
    stepId,
    ms: Date.now() - started,
  } as AgentToolRun<TTools>;

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
 * import { agent } from "inngest/experimental/agents";
 *
 * const { text } = await agent.loop({
 *   model: claude, // see `agent.model()`
 *   prompt: "Fix the failing test",
 *   tools: sandbox.tools.code(),
 * });
 * ```
 */
const loop = async <TTools extends SandboxTools>(
  options: AgentLoopOptions<TTools>,
): Promise<AgentLoopResult<TTools>> => {
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
  const toolRuns: AgentToolRun<TTools>[] = [];
  let text = "";

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const spent = await options.budget?.(turn);

    if (spent !== undefined) {
      return {
        text,
        stopped: "budget",
        reason: spent,
        turns: turn - 1,
        history: messages,
        usage,
        toolCalls: toolRuns,
      };
    }

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
      return runTool<TTools>(
        { ...options, maxToolOutput },
        turn,
        `${id}:${turn}.${index}:${call.name}`,
        call,
      );
    };
    let done: { result: AgentToolResult; run: AgentToolRun<TTools> }[];

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

    if (await options.stop?.(turn)) {
      return {
        text,
        stopped: "stopped",
        turns: turn,
        history: messages,
        usage,
        toolCalls: toolRuns,
      };
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
 * import { agent } from "inngest/experimental/agents";
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

/**
 * EXPERIMENTAL: The agent helpers: `agent.loop()` runs the model-and-tools
 * loop, `agent.model()` makes a model function, `agent.toolError()` returns an
 * error result from a tool and `agent.invoke()` starts another agent.
 *
 * @example
 * ```ts
 * import { agent } from "inngest/experimental/agents";
 *
 * const result = await agent.loop({ model, prompt: "Fix the test", tools });
 * ```
 */
export const agent = { loop, model, toolError, invoke };
