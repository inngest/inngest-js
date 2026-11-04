/**
 * @module
 * EXPERIMENTAL: `agent.loop()`, a model-and-tools loop where every model call
 * is a step and every tool call is a step (or a group of steps). A run replays
 * from its memoized turns, so a crash never repeats a model call or a tool.
 *
 * The loop knows nothing about providers. You pass a `model` function that
 * calls your SDK of choice and answers in the small shape below.
 */

import hashjs from "hash.js";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import {
  step,
  withSpan,
  withStepIdPrefix,
} from "../../../components/InngestStepTools.ts";
import {
  expandMcpTools,
  type McpServer,
} from "../../../components/sandbox/mcp.ts";
import {
  isToolError,
  resolveToolCall,
  type SandboxTools,
  type ToolInputType,
  type ToolJsonDefinition,
  type ToolOutputType,
  toolDefinitions,
  toolErrorOf,
} from "../../../components/sandbox/tools.ts";
import type { DurableSandbox } from "../../../components/sandbox/types.ts";
import type { IsAny } from "../../../helpers/types.ts";
import { nextCount } from "../agent/executionCounter.ts";
import { taggedKeyAddress } from "../agent/relations.ts";
import type { Json } from "../json.ts";
import { kv } from "../kv/kv.ts";
import { historyRecordKey } from "../threads/thread.ts";
import {
  type AgentCompaction,
  type AgentCompactionOptions,
  compactionFor,
  withCompaction,
} from "./context.ts";
import { type AgentPrice, priceOf } from "./cost.ts";
import { isTurnEnder } from "./endsTurn.ts";
import { sortModelError } from "./modelErrors.ts";
import { scoreThisStep } from "./scores.ts";
import { untrustedText } from "./untrustedText.ts";

/**
 * A content block of a user message, in the shape your model function sends
 * to its provider (`{ type: "text", text }`, `{ type: "image", ... }`).
 */
export interface AgentContentBlock {
  type: string;
  // Deliberate unknown: the rest of a block is the provider's own shape.
  [key: string]: unknown;
}

/**
 * What a user message holds: text, or content blocks.
 */
export type AgentUserContent = string | AgentContentBlock[];

/**
 * An event as the loop takes it: what an inbox message is, without its place
 * in the inbox.
 */
export interface AgentEvent {
  id?: string;
  name: string;
  // Deliberate unknown: event data comes from outside; the reader checks it.
  data: unknown;
}

/**
 * What goes into the conversation as a user message: text, content blocks, or
 * an event (an inbox message), which `format` turns into one of those.
 */
export type AgentInput = AgentUserContent | AgentEvent;

type Sender =
  | { kind: "agent"; address?: string; key?: string }
  | { kind: "function"; id?: string; key?: string };

// Who sent a message, as the model reads it.
/**
 * How many times a model that stops while it owes a report is reminded.
 */
const maxOwedReminders = 2;

const whoOf = (from: Sender | undefined): string => {
  if (from?.kind === "function") {
    return `function ${from.id ?? "unknown"}`;
  }

  return from?.address ?? "an agent";
};

const textOfJson = (value: unknown): string => {
  return typeof value === "string" ? value : JSON.stringify(value);
};

/**
 * The default wording of a message for the model. The four agent message
 * types read as sentences; any other event is its name and data as JSON.
 *
 * - `agent/message`: `Message from <address> (thread <key>): <content>` (from a
 *   plain function: `Message from function <id> (thread <key>): <content>`).
 *   A message with no sender is its text alone, except in the thread of an
 *   agent another agent started: there it reads `Message from outside the
 *   agent team (not from an agent): <content>`, so the model does not take it
 *   for its starter's.
 * - `agent/question`: the question, its id, who asked, and a pointer to the
 *   `reply` tool.
 * - `agent/finished`: which agent and thread finished, the outcome, then the
 *   output or the error, and the owed reports it never sent when the app has
 *   no KV store.
 * - `agent/group.joined`: who joined the group and the thread key to reach it
 *   with.
 * - a report (an event of the type the starter asked for, such as
 *   `milestone`): `Report "<type>" from <address> (thread <key>): <data>`.
 * - `agent/answer`: the answer next to the question it answers (`questions`
 *   maps a question's id to its text); `refused` and `timed_out` read as a
 *   plain "no answer" line.
 *
 * Call it from your own `format` for the messages you don't change.
 * @param event The message.
 * @param questions The text of the questions the model has open, by id.
 */
export const formatEvent = (
  event: AgentEvent,
  questions?: ReadonlyMap<string, string>,
): string => {
  const data = (event.data ?? {}) as Record<string, unknown>;
  // A report's data is its own, so its sender is beside it.
  const report =
    typeof (event as { report?: unknown }).report === "object" &&
    (event as { report?: unknown }).report !== null;
  const from = (report ? (event as { from?: unknown }).from : data.from) as
    | Sender
    | undefined;
  const where = from?.key === undefined ? "" : ` (thread ${from.key})`;

  if (event.name === "agent/message") {
    const content = data.content;

    if (content === undefined) {
      return JSON.stringify({ event: event.name, data: event.data });
    }

    if (from) {
      return `Message from ${whoOf(from)}${where}: ${textOfJson(content)}`;
    }

    // An agent that another agent started works for it, so a message from
    // anyone else says so. A thread a start made has a tagged key.
    const thread = getAsyncCtxSync()?.execution?.agent?.thread;

    return thread !== undefined && taggedKeyAddress(thread) !== undefined
      ? `Message from outside the agent team (not from an agent): ${textOfJson(content)}`
      : textOfJson(content);
  }

  if (event.name === "agent/question") {
    return `Question ${String(data.id)} from ${whoOf(from)}${where}: ${String(data.text)}\nAnswer it with the reply tool, giving the question id ${String(data.id)}.`;
  }

  if (event.name === "agent/finished") {
    const who = `${whoOf(from)}${where}`;
    const missing = Array.isArray(data.missing) ? data.missing : [];
    const owed =
      missing.length > 0
        ? ` It never sent the report${missing.length > 1 ? "s" : ""} it owed: ${missing.join(", ")}.`
        : "";

    if (data.outcome === "completed") {
      return data.output === undefined
        ? `${who} finished: completed.${owed}`
        : `${who} finished: completed. Output: ${textOfJson(data.output)}${owed}`;
    }

    if (data.outcome === "failed") {
      return `${who} finished: failed. Error: ${String(data.error)}${owed}`;
    }

    return `${who} finished: stopped.${owed}`;
  }

  if (event.name === "agent/group.joined") {
    const joined = data as {
      name?: unknown;
      agent?: unknown;
      thread?: unknown;
    };

    return `${String(joined.agent)} (thread ${String(joined.thread)}) joined your group "${String(joined.name)}". You can reach it with message_agent or ask_agent.`;
  }

  if (event.name === "agent/answer") {
    const id = String(data.re);
    const asked = questions?.get(id);
    const about = asked === undefined ? `question ${id}` : `"${asked}"`;

    if (data.outcome === "refused") {
      return `No answer to ${about}: ${whoOf(from)} refused.`;
    }

    if (data.outcome === "timed_out") {
      return `No answer to ${about}: ${whoOf(from)} did not answer in time.`;
    }

    return `Answer to ${about} from ${whoOf(from)}: ${textOfJson(data.text)}`;
  }

  if (report) {
    return `Report "${event.name}" from ${whoOf(from)}${where}: ${JSON.stringify(event.data)}`;
  }

  return JSON.stringify({ event: event.name, data: event.data });
};

/**
 * One message of the conversation. The loop keeps the `content` of an
 * `assistant` message exactly as your `model` function returned it, so
 * provider-specific parts (such as Anthropic thinking blocks and their
 * signatures) go back to the model untouched.
 */
export type ModelMessage =
  | { role: "user"; content: AgentUserContent }
  // Deliberate unknown: the assistant's blocks are the provider's own shape
  // and go back to the model untouched.
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
  // Deliberate unknown: the default for a tool whose input type is not known.
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
 * Tokens used by model calls. `input` counts every input token, cached or
 * not, so `input + output` is what a token budget counts.
 */
export interface AgentUsage {
  /**
   * Input tokens, including the cached ones.
   */
  input: number;

  /**
   * Output tokens.
   */
  output: number;

  /**
   * Cost in US dollars, when the loop was given a `price`.
   */
  usd?: number;

  /**
   * Of `input`, the tokens read from the provider's prompt cache. Set by
   * `anthropic()`; a model function that reports none leaves it out.
   */
  cacheRead?: number;

  /**
   * Of `input`, the tokens written to the provider's prompt cache.
   */
  cacheWrite?: number;

  /**
   * Of `cacheWrite`, the tokens written with the one-hour lifetime, which
   * Anthropic bills at a higher rate than the five-minute one.
   */
  cacheWrite1h?: number;
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
  messages: ModelMessage[];

  /**
   * This call's number, from 1.
   */
  turn: number;

  /**
   * The most model calls the loop will make.
   */
  maxTurns: number;

  /**
   * Whether the model may, must or must not call a tool. `"none"` on the
   * last turn when the loop has a `wrapUp` text: keep `tools` in the request,
   * since the conversation uses them, but forbid calling one. Otherwise the
   * loop's `toolChoice` option (Anthropic: `tool_choice`). Absent means
   * `"auto"`.
   */
  toolChoice?: AgentToolChoice;

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
  message: Extract<ModelMessage, { role: "assistant" }>;

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

  /**
   * The model that answered, such as `claude-sonnet-5-5`. It is given to
   * `price` to work out what the call cost.
   */
  model?: string;

  /**
   * What this call cost in US dollars, when the model knows its prices
   * (`anthropic()` does). A `price` on the loop overrides it. Default: not
   * known, and a dollar budget then needs a `price`.
   */
  usd?: number;

  /**
   * Anything else to report about the reply, such as its finish reason or
   * provider. It is stored with the step and shows up as `turn.model` in
   * `onTurn`. Default: none.
   */
  details?: Record<string, Json>;
}

/**
 * Calls a model once. It runs inside a step, so a failure is retried. The loop
 * gives up at once on a client error no retry can fix (a 4xx other than 408,
 * 409 and 429), and you can throw a
 * `NonRetriableError` yourself for anything else a retry can't help.
 */
export interface AgentModel {
  (request: AgentModelRequest): Promise<AgentModelResponse>;

  /**
   * The model's context size in tokens, if it knows it. A loop that remembers
   * summarises the conversation once it fills 70% of it.
   */
  contextWindow?: number;
}

const modelBrand: unique symbol = Symbol.for("inngest.agents.model");

/**
 * What marks a model function as a model, as opposed to a function of the
 * run's start that returns one. See `agentModel()`.
 */
export interface ModelValue {
  readonly [modelBrand]: true;
}

/**
 * Marks a function of the model's shape as a model. An agent's `model` is a
 * value or a function of `{ event, thread }`, and only a marked function (the
 * adapters, such as `anthropic()`, are) is used as the model itself.
 * @param fn The model function.
 */
export function agentModel<T extends AgentModel>(fn: T): T & ModelValue {
  return Object.assign(fn, { [modelBrand]: true as const });
}

/**
 * Whether a function was marked with `agentModel()`.
 * @param value Anything.
 */
export function isAgentModel(value: unknown): value is AgentModel & ModelValue {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[modelBrand] === true
  );
}

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
   * This turn's finished tool runs, in the order of `toolCalls`, with their
   * `output` and `isError`. Empty when the reply asked for no calls.
   */
  runs: AgentToolRun[];

  /**
   * The `details` the model function returned for this call, `undefined` if
   * it returned none.
   */
  model?: Record<string, Json>;

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
      [TName in keyof TTools & string]: IsMcpServer<TTools[TName]> extends true
        ? // An MCP server is many tools: the types cannot list their names,
          // their input is JSON, and their output comes from the server, so
          // `unknown` here is deliberate and pinned.
          AgentToolRunOf<
            `${TName}_${string}`,
            Record<string, unknown>,
            false,
            unknown
          >
        : AgentToolRunOf<
            TName,
            ToolInputType<TTools[TName]>,
            false,
            ToolOutputType<TTools[TName]>
          >;
    }[keyof TTools & string]
  | AgentToolRunOf<string, unknown, true, unknown>;

// Whether a tool entry is an MCP server, which is many tools.
type IsMcpServer<T> = IsAny<T> extends true
  ? false
  : T extends McpServer
    ? true
    : false;

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
 * The most model calls a loop makes when neither its options nor the call set
 * `maxTurns`.
 */
export const defaultMaxTurns = 40;

/**
 * Whether the model may call a tool (`"auto"`), must call one (`"required"`),
 * must not (`"none"`), or must call the named one (`{ tool }`).
 */
export type AgentToolChoice = "auto" | "required" | "none" | { tool: string };

/**
 * What goes into a loop call: a batch of messages (events), or text or content
 * blocks as they are.
 */
export type AgentLoopInput = AgentInput | readonly AgentEvent[];

/**
 * How a loop ended: the model finished (`"done"`), it ran out of turns
 * (`"maxTurns"`), the `stop` option asked to end it (`"stop"`), the budget
 * was spent (`"budget"`), or it kept replying without a tool call under
 * `toolChoice: "required"` past `maxNoToolCall` (`"noToolCall"`).
 */
export type AgentLoopEnd =
  | "done"
  | "maxTurns"
  | "stop"
  | "budget"
  | "noToolCall";

/**
 * Options of `agent.loop()`. A loop made on its own has only what its options
 * give it, so `model` is required.
 */
export interface AgentLoopOptions<TTools extends SandboxTools = SandboxTools> {
  /**
   * Prefix of the step IDs. Default `"agent"`. A second loop with the same
   * prefix in one run gets `-2` after it, a third `-3`, so loops can repeat
   * in one function without choosing IDs. The first keeps the plain prefix.
   */
  id?: string;

  /**
   * Calls your model once per turn: `anthropic({ model })` or any function of
   * the model's shape.
   */
  model: AgentModel;

  /**
   * The system prompt. Default: none.
   */
  system?: string;

  /**
   * Turns an event (a message in the batch, or one folded in) into what the
   * model sees: text or content blocks. Default: `formatEvent`.
   */
  format?: (event: AgentEvent) => AgentUserContent;

  /**
   * Tools the model can call, declared like sandbox tools. A tool that
   * throws, or returns `agent.toolError(body)`, gives the model an error
   * result to react to. Default: none.
   */
  tools?: TTools;

  /**
   * The most characters of one tool result the model sees; a longer one keeps
   * its start and end and says how much is missing. Set it high: a result cut
   * short is information the model never gets back, unless `spill` saves the
   * whole of it. Default 100000.
   */
  maxToolOutput?: number;

  /**
   * Where the whole of a result goes when it is longer than `maxToolOutput`:
   * a file in a sandbox, whose path the model is told, so it can read the
   * part it needs with a tool. `dir` is where the files go and must exist.
   * Default: nothing is saved. Example: `spill: { sandbox }`.
   */
  spill?: { sandbox: Pick<DurableSandbox, "files">; dir?: string };

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
   * Whether the model may call a tool: `"auto"` (it decides, and a reply
   * without a tool call ends the loop), `"required"` (every reply must call
   * a tool), `"none"`, or `{ tool }` (every reply must call that tool).
   * Under `"required"` or `{ tool }` a reply with no tool call ends nothing:
   * the loop asks again, without using a turn of `maxTurns`. Default
   * `"auto"`.
   */
  toolChoice?: AgentToolChoice;

  /**
   * The most replies without a tool call to tolerate under `toolChoice:
   * "required"` or `{ tool }`. Past it the loop ends with `end:
   * "noToolCall"`. Default 4.
   */
  maxNoToolCall?: number;

  /**
   * The `history` of an earlier result, to continue its conversation.
   */
  history?: ModelMessage[];

  /**
   * Chooses what to fold. Before each model call the loop takes everything new
   * from the inboxes it reads and passes it here; return the messages to fold
   * into that call. The rest come back on the result as `unread`. Default:
   * fold them all.
   */
  steer?: (drained: AgentEvent[]) => AgentEvent[] | Promise<AgentEvent[]>;

  /**
   * Checked before each model call. Return `true` to end the loop with
   * `end: "stop"`. `runs` are the tool runs finished so far. It runs in your
   * function, so it can use steps to read a durable flag. See `hasToolCall`.
   */
  stop?: (call: {
    turn: number;
    runs: AgentToolRun<TTools>[];
  }) => boolean | Promise<boolean>;

  /**
   * Called before each model call. Return a reason to end the loop with
   * `end: "budget"` and that `reason`. Inside an agent the thread's budget
   * is checked as well, always.
   */
  budget?: (turn: number) => string | undefined | Promise<string | undefined>;

  /**
   * The text to send on the last turn (the `maxTurns`th call), with no
   * tool use allowed, so the model has to write its answer.
   */
  wrapUp?: string;

  /**
   * Summarises the start of the conversation once it nears the model's
   * context window. Until then every call sends the whole conversation, so a
   * provider's prompt cache keeps hitting the same prefix and no old message
   * or tool result is ever edited. Past `maxTokens`, everything but the last
   * `keep` messages becomes one summary message. The summary is made once,
   * kept in that model step's saved output (so a replay restores it) and
   * reused until the conversation passes the budget again. The `history` you
   * get back is never summarised. Default: off, the conversation is always
   * sent whole. Example: `compaction: { maxTokens: 700_000 }`.
   */
  compaction?: AgentCompactionOptions;

  /**
   * Called after each turn's tool calls, for progress. It is not awaited
   * between turns and an error in it is logged and never fails the run; the
   * loop waits for the last call before it returns. Steps inside it are
   * allowed.
   */
  onTurn?: (turn: AgentTurn) => void | Promise<void>;

  /**
   * Overrides what a model call costs. The model reports its own cost when it
   * knows its prices (`anthropic()` does), so a dollar budget needs no price.
   * Give one for a model function that reports none, or to replace the
   * model's: a function of that call's tokens and model that returns US
   * dollars, or rates per million tokens by model name (`"*"` for any other).
   * The cost is worked out once, inside the model call's step, and a replay
   * reuses it.
   */
  price?: AgentPrice;
}

/**
 * What a call of a loop can set for itself: more `tools` (added to the loop's;
 * the same name twice is an error), and its own `steer`, `onTurn`, `maxTurns`,
 * `maxToolOutput`, `wrapUp`, `toolChoice` and `maxNoToolCall`.
 */
export interface AgentLoopCallOptions<
  TTools extends SandboxTools = Record<never, never>,
> extends Pick<
    AgentLoopOptions,
    | "steer"
    | "onTurn"
    | "maxTurns"
    | "maxToolOutput"
    | "wrapUp"
    | "toolChoice"
    | "maxNoToolCall"
  > {
  /**
   * Tools to add to the loop's own for this call.
   */
  tools?: TTools;
}

/**
 * What `agent.loop()` returns. The `"budget"` end carries a `reason`; no other
 * end has one.
 */
export type AgentLoopResult<TTools extends SandboxTools = AnyTools> =
  AgentLoopResultBase<TTools> &
    (
      | {
          end: "budget";
          /**
           * Why the loop ended, for `end: "budget"`.
           */
          reason: string;
        }
      | {
          end: Exclude<AgentLoopEnd, "budget">;
          reason?: never;
        }
    );

/**
 * What every end of a loop gives.
 */
export interface AgentLoopResultBase<TTools extends SandboxTools = AnyTools> {
  /**
   * The text of the last model reply.
   */
  text: string;

  /**
   * How many model calls the loop made.
   */
  turns: number;

  /**
   * How many replies came with no tool call under `toolChoice: "required"`
   * (or `{ tool }`) and were asked again. They do not count against
   * `maxTurns`.
   */
  noToolCallTurns: number;

  /**
   * The whole conversation. Pass it as `history` to continue.
   */
  history: ModelMessage[];

  /**
   * Tokens used by every model call of this loop.
   */
  usage: AgentUsage;

  /**
   * Every tool call this loop made, in order.
   */
  toolCalls: AgentToolRun<TTools>[];

  /**
   * The messages a custom `steer` took from the inboxes and did not fold.
   */
  unread: AgentEvent[];

  /**
   * The summary of the conversation's start, when the loop made one. Pass it
   * back with the `history` to carry on without paying for it again.
   */
  compaction?: AgentCompaction;
}

/**
 * A loop: runs the model on a batch, with the options it was made with and
 * the options of the call.
 */
export interface AgentLoop<TTools extends SandboxTools = AnyTools> {
  <TExtra extends SandboxTools = Record<never, never>>(
    batch: AgentLoopInput,
    options?: AgentLoopCallOptions<TExtra>,
  ): Promise<AgentLoopResult<TTools & TExtra>>;
}

/**
 * The loop a handler gets: the agent's own, with `with()` to derive another
 * from it.
 */
export interface AgentHandlerLoop<TTools extends SandboxTools = AnyTools>
  extends AgentLoop<TTools> {
  /**
   * A loop derived from this one: its model, system, tools and remembered
   * history, with the options overriding what they name (`model`, `system`)
   * and adding to what they extend (`tools`; the same name twice is an
   * error). Nothing else is restated.
   */
  with<TExtra extends SandboxTools = Record<never, never>>(
    options: Partial<Omit<AgentLoopOptions<TExtra>, "id">>,
  ): AgentHandlerLoop<TTools & TExtra>;
}

/**
 * What the agent that runs a loop gives it, read when the loop runs: the
 * inboxes to fold, the thread's budget, and the record of each turn. Internal.
 */
export interface AgentLoopWiring {
  /**
   * Takes everything new from the inboxes the loop folds from, in order.
   */
  drain?: (call: { turn: number }) => Promise<AgentEvent[]>;

  /**
   * The inboxes the model opened, with the source each was opened on.
   */
  inboxes?: () => { as: string; source: { event: string; if: string } }[];

  /**
   * The reason the thread's budget is spent, if it is.
   */
  budget?: () => string | undefined;

  /**
   * The agent's the agent's `price`.
   */
  price?: AgentPrice;

  /**
   * Records the turn inside the model call's step, so it costs no step of its
   * own. What it returns rides with the reply.
   */
  recordTurn?: (turn: AgentTurn) => Promise<unknown>;

  /**
   * Called as soon as a model call has answered, with what `recordTurn`
   * returned.
   */
  observeTurn?: (turn: AgentTurn, recorded: unknown) => Promise<void>;

  /**
   * The agent, as `"appId/functionId"`: the history is kept under its own key
   * on the thread, so two agents sharing a thread key each remember their own.
   */
  agent?: string;

  /**
   * Whether the loop saves the model's history in thread KV after each batch
   * and picks it up when the thread's next run starts. The agent's `remember`
   * field, `true` unless it says `false`.
   */
  remember?: boolean;

  /**
   * The report types the run still owes. A model that tries to finish while
   * this is not empty is reminded and the loop continues.
   */
  owed?: () => string[] | Promise<string[]>;

  /**
   * Whether a question already has a reply, so the model spends no turn on it.
   * Filled by the messaging work.
   */
  answered?: (id: string) => boolean | Promise<boolean>;

  /**
   * The text of the questions the model has open, by id, to show an answer next
   * to its question. Filled by the messaging work.
   */
  questions?: () => ReadonlyMap<string, string>;

  /**
   * Called with the IDs of the messages folded into a model call.
   */
  folded?: (call: { turn: number; ids: string[] }) => void;

  /**
   * The loop an agent's handler (or its default handler) runs, derived from.
   */
  defaults?: Partial<AgentLoopOptions>;
}

const clip = (text: string, max: number): string => {
  if (text.length <= max) {
    return text;
  }

  const half = max / 2;

  return `${text.slice(0, half)}\n... clipped ${text.length - max} characters ...\n${text.slice(-half)}`;
};

const addUsage = (
  base: AgentUsage | undefined,
  extra: AgentUsage,
): AgentUsage => {
  const total: AgentUsage = {
    input: (base?.input ?? 0) + extra.input,
    output: (base?.output ?? 0) + extra.output,
  };

  for (const key of ["cacheRead", "cacheWrite", "cacheWrite1h"] as const) {
    if (base?.[key] !== undefined || extra[key] !== undefined) {
      total[key] = (base?.[key] ?? 0) + (extra[key] ?? 0);
    }
  }

  return total;
};

/**
 * The text of a result the model sees: whole, or clipped with the whole saved
 * to a sandbox file when `spill` is set.
 */
const shown = async (
  options: { maxToolOutput: number; spill?: AgentLoopOptions["spill"] },
  stepId: string,
  name: string,
  content: string,
): Promise<string> => {
  if (content.length <= options.maxToolOutput) {
    return content;
  }

  const clipped = clip(content, options.maxToolOutput);

  if (!options.spill) {
    return clipped;
  }

  // Named by the content, so runs sharing a sandbox never overwrite a file a
  // conversation was told about.
  const hash = hashjs.sha256().update(content).digest("hex").slice(0, 16);
  const path = `${options.spill.dir ?? "/tmp"}/tool-output-${hash}.txt`;

  try {
    await options.spill.sandbox.files.write(
      { id: `${stepId}:spill`, name: `Save the full output of ${name}` },
      { path, data: content },
    );
  } catch (error) {
    return `${clipped}\nThe full output could not be saved: ${error instanceof Error ? error.message : String(error)}`;
  }

  return `${clipped}\nThe full output is saved in the sandbox at ${path}`;
};

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
const toolError = toolErrorOf;

const wrapUntrusted = (
  content: string,
  untrusted: { source?: string } | undefined,
): string => {
  return untrusted ? untrustedText(content, untrusted) : content;
};

const runTool = async <TTools extends SandboxTools>(
  options: AgentLoopOptions<TTools> & {
    tools: TTools;
    maxToolOutput: number;
  },
  turn: number,
  stepId: string,
  call: AgentToolCall,
): Promise<{ result: AgentToolResult; run: AgentToolRun<TTools> }> => {
  const started = Date.now();
  let output: unknown;
  let isError = false;
  let untrusted: { source?: string } | undefined;

  try {
    const input = (call.input ?? {}) as Record<string, unknown>;
    const resolved = await resolveToolCall(
      options.tools,
      { op: "call", id: 0, tool: call.name, args: [], kwargs: input },
      JSON.stringify(input),
      { fromModel: true },
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
        : await step.run({ id: stepId, name, "~span": span }, async () => {
            const toolStarted = Date.now();

            try {
              const answer = await resolved.invoke(context);

              scoreThisStep("agent.tool_ms", Date.now() - toolStarted);
              scoreThisStep("agent.tool_error", isToolError(answer) ? 1 : 0);

              return answer;
            } catch (error) {
              scoreThisStep("agent.tool_ms", Date.now() - toolStarted);
              scoreThisStep("agent.tool_error", 1);

              throw error;
            }
          });

      isError = isToolError(value);
      output = isToolError(value) ? value["~error"] : value;
      untrusted = resolved.untrusted;
    }
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
    isError = true;
  }

  const text = typeof output === "string" ? output : JSON.stringify(output);
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

  return {
    run,
    result: {
      toolCallId: call.id,
      name: call.name,
      input: call.input,
      // Only what the model reads is wrapped: `output` stays as the tool
      // returned it, and sandbox code gets the plain result.
      content: wrapUntrusted(
        await shown(options, stepId, call.name, text ?? ""),
        isError ? undefined : untrusted,
      ),
      ...(isError && { isError }),
    },
  };
};

/**
 * The wiring of the agent run this loop is part of, if any.
 */
const bridgedWiring = (): AgentLoopWiring | undefined => {
  return getAsyncCtxSync()?.execution?.agentBridge?.wiring;
};

/**
 * Logs an error of the loop's own hooks, which never fail the run.
 */
const logHookError = (what: string, error: unknown) => {
  const logger = getAsyncCtxSync()?.execution?.ctx as unknown as
    | { logger?: { error: (message: string) => void } }
    | undefined;
  const message = `${what} failed: ${error instanceof Error ? error.message : String(error)}`;

  if (logger?.logger) {
    logger.logger.error(message);
  } else {
    console.error(message);
  }
};

/**
 * The step ID prefix of this loop: `id` for the first loop of that name in an
 * execution of the function, then `id-2`, `id-3`. The count starts again on
 * every replay and the loops run in the same order, so a loop gets the same
 * prefix each time.
 */
const uniqueLoopId = (id: string): string => {
  const execution = getAsyncCtxSync()?.execution;
  const n = execution ? nextCount(execution.instance, `loop:${id}`) : 0;

  return n === 0 ? id : `${id}-${n + 1}`;
};

// The cost stored on a model step, when it is a usable number of dollars.
const storedCost = (usd: unknown): number | undefined => {
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0
    ? usd
    : undefined;
};

/**
 * Adds tools to a loop's own. The same name twice is an error, since the
 * model could only reach one of them, except over a built-in that ends the
 * turn (`wait`): yours replaces it.
 */
export const addTools = <TTools extends SandboxTools>(
  own: SandboxTools | undefined,
  extra: TTools | undefined,
): SandboxTools => {
  for (const name of Object.keys(extra ?? {})) {
    if (own && Object.hasOwn(own, name) && !isTurnEnder(own[name])) {
      throw new Error(
        `The tool "${name}" is added twice: the loop already has a tool of that name`,
      );
    }
  }

  return { ...own, ...extra };
};

// The thread KV key an agent's model history is kept under.
const historyKeyOf = (agent: string | undefined) => {
  return kv.key<Remembered>(historyRecordKey(agent ?? ""));
};

interface Remembered {
  history: ModelMessage[];
  compaction?: AgentCompaction;
}

/**
 * Runs the loop once on a batch, with options already resolved.
 */
const runLoop = async <TTools extends SandboxTools>(
  options: AgentLoopOptions<TTools> & { tools: TTools },
  batch: AgentLoopInput,
): Promise<AgentLoopResult<TTools>> => {
  const {
    model,
    system,
    maxTurns = defaultMaxTurns,
    maxToolOutput = 100_000,
    parallelTools = true,
    toolChoice = "auto",
    maxNoToolCall = 4,
  } = options;
  const forcesTool = toolChoice !== "auto" && toolChoice !== "none";
  const wiring = bridgedWiring();
  const price = options.price ?? wiring?.price;
  const id = uniqueLoopId(options.id ?? "agent");
  // The key of an MCP server in `tools` names its tools; its list is a step.
  const tools = (await expandMcpTools(options.tools ?? {}, id)) as TTools;
  const definitions = toolDefinitions(tools);
  const format =
    options.format ??
    ((event: AgentEvent) => {
      return formatEvent(event, wiring?.questions?.());
    });
  const contentOf = (input: AgentInput): AgentUserContent => {
    return typeof input === "string" || Array.isArray(input)
      ? input
      : format(input as unknown as AgentEvent);
  };
  const isEvents = (input: AgentLoopInput): input is readonly AgentEvent[] => {
    return (
      Array.isArray(input) &&
      input.every((item) => {
        return (
          typeof item === "object" &&
          item !== null &&
          typeof (item as unknown as AgentEvent).name === "string"
        );
      })
    );
  };
  const prompt: AgentUserContent = isEvents(batch)
    ? batch
        .map((event) => {
          const formatted = format(event);

          return typeof formatted === "string"
            ? formatted
            : JSON.stringify(formatted);
        })
        .join("\n\n")
    : contentOf(batch as AgentInput);
  // A loop in an agent picks up what the thread's earlier runs left, unless it
  // was given a history of its own.
  const remembering = wiring?.remember === true;
  const stored =
    remembering && options.history === undefined
      ? ((await kv.thread.get(historyKeyOf(wiring?.agent))) as
          | Remembered
          | undefined)
      : undefined;
  const messages: ModelMessage[] = [
    ...(options.history ?? stored?.history ?? []),
    { role: "user", content: prompt },
  ];
  const usage: AgentUsage = { input: 0, output: 0 };
  const toolRuns: AgentToolRun<TTools>[] = [];
  const unread: AgentEvent[] = [];
  // The `onTurn` calls in flight: not awaited between turns, awaited at the end.
  const hooks: Promise<void>[] = [];
  let text = "";
  // Messages folded in since the last model call.
  let steered = 0;
  // Replies with no tool call that were asked again.
  let noToolCallTurns = 0;
  // Times the model was reminded of a report it owes.
  let owedReminders = 0;
  // The summary of the conversation's start, once there is one.
  let compaction: AgentCompaction | undefined = stored?.compaction;
  const compactWith = compactionFor(options.compaction, model.contextWindow);

  const finish = async (
    end: AgentLoopEnd,
    turns: number,
    reason?: string,
  ): Promise<AgentLoopResult<TTools>> => {
    await Promise.allSettled(hooks);

    if (remembering) {
      try {
        await kv.thread.set(historyKeyOf(wiring?.agent), {
          history: messages,
          ...(compaction && { compaction }),
        } as Remembered as never);
      } catch (error) {
        // The ledger KV store holds 128 KB per thread: a history past it is
        // not kept, and the run does not fail for it.
        if (!/past the limit of \d+ bytes/.test(String(error))) {
          throw error;
        }

        logHookError("remember", error);
      }
    }

    return {
      text,
      end,
      ...(reason !== undefined && { reason }),
      turns,
      noToolCallTurns,
      history: messages,
      usage,
      toolCalls: toolRuns,
      unread,
      ...(compaction && { compaction }),
      // Only the "budget" end is given a reason, so the object is one of the
      // union's members; the compiler cannot relate `end` to `reason` here.
    } as AgentLoopResult<TTools>;
  };

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (await options.stop?.({ turn, runs: toolRuns })) {
      return finish("stop", turn - 1);
    }

    const spent = (await options.budget?.(turn)) ?? wiring?.budget?.();

    if (spent !== undefined) {
      return finish("budget", turn - 1, spent);
    }

    // Everything new in the inboxes lands in this model call.
    const taken = (await wiring?.drain?.({ turn })) ?? [];
    const drained: AgentEvent[] = [];

    // A question that already has a reply costs the model no turn.
    for (const event of taken) {
      const questionId =
        event.name === "agent/question"
          ? (event.data as { id?: unknown } | null)?.id
          : undefined;

      if (
        typeof questionId === "string" &&
        (await wiring?.answered?.(questionId))
      ) {
        continue;
      }

      drained.push(event);
    }

    if (drained.length > 0) {
      const chosen = options.steer ? await options.steer(drained) : drained;

      for (const event of drained) {
        if (!chosen.includes(event)) {
          unread.push(event);
        }
      }

      for (const event of chosen) {
        messages.push({ role: "user", content: contentOf(event) });
      }

      steered = chosen.length;
      wiring?.folded?.({
        turn,
        ids: chosen.flatMap((event) => {
          return event.id === undefined ? [] : [event.id];
        }),
      });
    }

    const modelStep =
      noToolCallTurns > 0
        ? `${id}:model:${turn}.${noToolCallTurns}`
        : `${id}:model:${turn}`;
    const reply = (await step.run(
      {
        id: modelStep,
        name: "Thinking",
        "~span": { id: modelStep, name: "Thinking", kind: "llm" },
      },
      async () => {
        const last = turn === maxTurns && options.wrapUp !== undefined;
        const started = Date.now();
        let answer: AgentModelResponse;
        let made: AgentCompaction | undefined;
        let summaryUsage: AgentUsage | undefined;
        let sent = messages;

        // A 4xx no retry can fix (a rejected request, a bad key) ends the run
        // instead of retrying it, and a retry-after is honoured.
        try {
          if (compactWith) {
            const compacted = await withCompaction({
              messages,
              held: compaction,
              options: compactWith,
              summarise: async (summaryPrompt, text) => {
                const summary = await model({
                  system: summaryPrompt,
                  messages: [{ role: "user", content: text }],
                  tools: [],
                  turn,
                  maxTurns,
                });

                return { text: summary.text ?? "", usage: summary.usage };
              },
            });

            sent = compacted.messages;
            made = compacted.made;
            summaryUsage = compacted.usage;
          }

          answer = await model({
            system,
            messages: last
              ? [...sent, { role: "user", content: options.wrapUp as string }]
              : sent,
            tools: definitions,
            turn,
            maxTurns,
            ...(last
              ? { toolChoice: "none" as const }
              : toolChoice !== "auto" && { toolChoice }),
          });
        } catch (error) {
          throw sortModelError(error);
        }

        scoreThisStep("agent.model_ms", Date.now() - started);
        scoreThisStep("agent.tool_calls", answer.toolCalls.length);
        scoreThisStep("agent.steers", steered);

        if (answer.usage) {
          scoreThisStep("agent.input_tokens", answer.usage.input);
          scoreThisStep("agent.output_tokens", answer.usage.output);

          if (answer.usage.cacheRead !== undefined) {
            scoreThisStep("agent.cache_read_tokens", answer.usage.cacheRead);
          }

          if (answer.usage.cacheWrite !== undefined) {
            scoreThisStep("agent.cache_write_tokens", answer.usage.cacheWrite);
          }
        }

        // Priced here and stored with the reply, so a replay uses the number
        // the call was priced at. A `price` overrides the model's own cost; a
        // reply that reported no tokens costs nothing.
        if (summaryUsage) {
          answer = { ...answer, usage: addUsage(answer.usage, summaryUsage) };
        }

        const priced: AgentModelResponse = price
          ? {
              ...answer,
              usd: priceOf(
                price,
                answer.usage ?? { input: 0, output: 0 },
                answer.model,
              ),
            }
          : answer;

        const recorded = await wiring?.recordTurn?.({
          turn,
          stepId: modelStep,
          text: priced.text ?? "",
          toolCalls: priced.toolCalls,
          runs: [],
          model: priced.details,
          usage: {
            ...(priced.usage ?? { input: 0, output: 0 }),
            ...(priced.usd !== undefined && { usd: priced.usd }),
          },
        });

        // A compaction made here rides in the step's output, so a replay,
        // which does not run this function, still restores it. So does what
        // the turn recorded.
        return {
          ...priced,
          ...(made && { compaction: made }),
          ...(recorded !== undefined && { recorded }),
        };
      },
    )) as AgentModelResponse & {
      compaction?: AgentCompaction;
      recorded?: unknown;
    };
    steered = 0;

    if (reply.compaction) {
      compaction = reply.compaction;
    }

    const callUsage = reply.usage ?? { input: 0, output: 0 };
    // A step memoized before the cost was stored with it has no `usd`: price
    // it now.
    const cost = price
      ? (storedCost(reply.usd) ?? priceOf(price, callUsage, reply.model))
      : storedCost(reply.usd);

    usage.input += callUsage.input;
    usage.output += callUsage.output;

    for (const key of ["cacheRead", "cacheWrite", "cacheWrite1h"] as const) {
      const used = callUsage[key];

      if (used !== undefined) {
        usage[key] = (usage[key] ?? 0) + used;
      }
    }

    if (cost !== undefined) {
      usage.usd = (usage.usd ?? 0) + cost;
    }

    text = reply.text ?? "";
    messages.push(reply.message);

    const turnInfo: AgentTurn = {
      turn,
      stepId: modelStep,
      text,
      toolCalls: reply.toolCalls,
      runs: [],
      model: reply.details,
      usage: { ...callUsage, ...(cost !== undefined && { usd: cost }) },
    };

    // The agent's own record of the turn is read back before the next budget
    // check; it is not the app's `onTurn`.
    await wiring?.observeTurn?.(turnInfo, reply.recorded);

    const onTurn = (callOnTurn: AgentLoopOptions["onTurn"]) => {
      if (!callOnTurn) {
        return;
      }

      // Not awaited: a slow hook never delays the next model call, and an
      // error in it never fails the run.
      hooks.push(
        Promise.resolve()
          .then(() => {
            return callOnTurn(turnInfo);
          })
          .catch((error: unknown) => {
            logHookError("onTurn", error);
          }),
      );
    };

    // A model that stops while a report is owed is reminded, up to a few
    // times, and the loop goes on within `maxTurns` and the budget.
    const remindOwed = async (): Promise<boolean> => {
      const owed = (await wiring?.owed?.()) ?? [];

      if (
        owed.length === 0 ||
        owedReminders >= maxOwedReminders ||
        turn >= maxTurns
      ) {
        return false;
      }

      owedReminders += 1;
      messages.push({
        role: "user",
        content: `You still owe a ${owed.join(" and a ")} report. Send it with the report tool before you finish.`,
      });

      return true;
    };

    if (reply.toolCalls.length === 0) {
      onTurn(options.onTurn);

      // Under a forced tool choice a text reply is not an answer: ask again
      // without using up a turn.
      if (forcesTool && !(turn === maxTurns && options.wrapUp !== undefined)) {
        if (noToolCallTurns >= maxNoToolCall) {
          return finish("noToolCall", turn);
        }

        noToolCallTurns += 1;
        messages.push({
          role: "user",
          content: "Use the tools: every reply must be a tool call.",
        });
        turn -= 1;
        continue;
      }

      if (await remindOwed()) {
        continue;
      }

      return finish("done", turn);
    }

    const run = (call: AgentToolCall, index: number) => {
      return runTool<TTools>(
        { ...options, tools, maxToolOutput },
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
    turnInfo.runs = done.map(({ run: finished }) => finished) as AgentToolRun[];
    messages.push({ role: "tool", results: done.map(({ result }) => result) });
    onTurn(options.onTurn);

    // A built-in that ends the turn (`wait`) ran: once every call of the
    // reply has run, the loop ends as it does on a reply with no tool call.
    const endedTurn = done.some(({ run: finished }) => {
      return !finished.isError && isTurnEnder(tools[finished.name]);
    });

    if (endedTurn) {
      if (await remindOwed()) {
        continue;
      }

      return finish("done", turn);
    }
  }

  return finish("maxTurns", maxTurns);
};

/**
 * Merges what a call sets into the loop's options.
 */
const withCall = <TTools extends SandboxTools>(
  options: AgentLoopOptions<TTools>,
  call: AgentLoopCallOptions | undefined,
): AgentLoopOptions<TTools> & { tools: TTools } => {
  return {
    ...options,
    ...(call?.steer && { steer: call.steer }),
    ...(call?.onTurn && { onTurn: call.onTurn }),
    ...(call?.maxTurns !== undefined && { maxTurns: call.maxTurns }),
    ...(call?.maxToolOutput !== undefined && {
      maxToolOutput: call.maxToolOutput,
    }),
    ...(call?.wrapUp !== undefined && { wrapUp: call.wrapUp }),
    ...(call?.toolChoice !== undefined && { toolChoice: call.toolChoice }),
    ...(call?.maxNoToolCall !== undefined && {
      maxNoToolCall: call.maxNoToolCall,
    }),
    tools: addTools(options.tools, call?.tools) as TTools,
  };
};

/**
 * Makes a loop from its options. Internal: `agent.loop()` is this, and so is
 * the loop of a handler, with options the agent supplied.
 */
export const buildLoop = <TTools extends SandboxTools>(
  options: AgentLoopOptions<TTools>,
): AgentLoop<TTools> => {
  return (async (batch: AgentLoopInput, call?: AgentLoopCallOptions) => {
    return runLoop<TTools>(withCall(options, call), batch);
  }) as AgentLoop<TTools>;
};

/**
 * Makes the loop a handler gets: the agent's own, with `with()`.
 */
export const buildHandlerLoop = <TTools extends SandboxTools>(
  options: AgentLoopOptions<TTools>,
): AgentHandlerLoop<TTools> => {
  const own = buildLoop(options);

  return Object.assign(own, {
    with: (overrides: Partial<AgentLoopOptions>) => {
      return buildHandlerLoop({
        ...options,
        ...overrides,
        tools: addTools(options.tools, overrides.tools),
      } as AgentLoopOptions);
    },
  }) as unknown as AgentHandlerLoop<TTools>;
};

/**
 * EXPERIMENTAL: Makes a loop that runs a model with tools until it is done.
 * Each model call is one step, and each tool call is one step (a group of
 * steps for `tool.group()`). A loop made on its own has only the options you
 * give it, so `model` is required.
 *
 * Inside an agent the loop wires itself to the thread's inbox, budget and
 * scores: messages that arrive while it works reach the very next model call.
 *
 * @example
 * ```ts
 * import { agent, anthropic } from "inngest/experimental/agents";
 *
 * const loop = agent.loop({
 *   model: anthropic({ model: "claude-sonnet-5-5" }),
 *   tools: sandbox.tools.defaults,
 * });
 * const { text } = await loop("Fix the failing test");
 * ```
 */
const loop = <TTools extends SandboxTools>(
  options: AgentLoopOptions<TTools>,
): AgentLoop<TTools> => {
  return buildLoop(options);
};

/**
 * A `stop` function that is true once a tool named `name` has run without
 * error. A refused call (`agent.toolError(...)`) does not stop the loop.
 */
export const hasToolCall =
  (name: string) =>
  ({
    runs,
  }: {
    runs: readonly { name: string; isError: boolean }[];
  }): boolean =>
    runs.some((run) => run.name === name && !run.isError);

/**
 * EXPERIMENTAL: The agent helpers: `agent.loop()` makes a model-and-tools
 * loop and `agent.toolError()` returns an error result from a tool.
 *
 * @example
 * ```ts
 * import { agent } from "inngest/experimental/agents";
 *
 * const result = await agent.loop({ model, tools })("Fix the test");
 * ```
 */
export const agent = {
  loop,
  toolError,
};
