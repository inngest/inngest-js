/**
 * @module
 * EXPERIMENTAL: the agent tools a model gets to work with other agents. None
 * of them waits: `start_agent` returns the new thread's key at once, and what
 * comes back (the end of the run, a question, an answer) reaches the model as
 * a message in its inbox. A model agent can therefore never deadlock on
 * another agent.
 *
 * - `start_agent({ address, input?, attach? })`: starts an agent on a new
 *   thread; with `attach` it ends when the model's run does.
 * - `stop_agent({ thread })`: stops the run of a thread the model started.
 *
 * Sandbox code gets the same two plus `agent_result({ thread })`, which waits
 * for the run's end: code waits, so nothing it started lands in an inbox.
 */

import { z } from "zod/v4";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import type { ToolDescriptionParts } from "../../../components/sandbox/toolDescription.ts";
import {
  type AgentTool,
  type SandboxTool,
  tool,
} from "../../../components/sandbox/tools.ts";
import {
  type AgentDiscovery,
  type DiscoveryToolSet,
  type DiscoveryToolSetOptions,
  discoveryOptionsOf,
  discoveryToolSet,
  findCard,
  prepareInput,
  publicCardOf,
} from "../discovery/discovery.ts";
import { startability } from "../discovery/functions.ts";
import { checkAgainstSchema } from "../discovery/inputCheck.ts";
import { answerQuestion } from "../inbox/answer.ts";
import { agentAskTimeout, agentQuestion } from "../inbox/events.ts";
import {
  noteOwes,
  owesRecord,
  type ReportSpec,
  requiredReports,
  reservedReportType,
} from "../inbox/reports.ts";
import type { Json, JsonSchema } from "../json.ts";
import { kv } from "../kv/kv.ts";
import { endsTurn } from "../loop/endsTurn.ts";
import {
  sendMessage,
  threadHandle,
  threadSessions,
} from "../threads/thread.ts";
import { trackChild } from "./children.ts";
import { nextCount } from "./executionCounter.ts";
import {
  type Grant,
  grantOfExecution,
  proofOf,
  renewalOfExecution,
} from "./grant.ts";
import { agentOfKey, relationOf } from "./relations.ts";
import { AgentStoppedError } from "./runResults.ts";
import { senderOf } from "./sender.ts";
import { type StartedThread, startThread } from "./startThread.ts";

/**
 * Options of the agent tools.
 */
export interface AgentToolSetOptions extends DiscoveryToolSetOptions {}

/**
 * The tools that start, message and stop agents.
 */
type AgentActionToolSet = {
  start_agent: AgentTool<
    { address: string; input?: Json; attach?: boolean },
    { thread: string }
  >;
  message_agent: AgentTool<{ thread: string; content: Json }, { ok: true }>;
  ask_agent: AgentTool<{ thread: string; question: string }, { id: string }>;
  stop_agent: AgentTool<{ thread: string }, { ok: true }>;
  reply: AgentTool<{ to: string; text: string }, { ok: true }>;
};

/**
 * Every tool a model agent gets by default: the discovery tools and the ones
 * that start, message and stop agents.
 */
export type AgentToolSet = DiscoveryToolSet & AgentActionToolSet;

const clientOf = (): Inngest.Any => {
  const client = getAsyncCtxSync()?.app as unknown as Inngest.Any | undefined;

  if (!client) {
    throw new Error(
      "The agent tools must be called inside an Inngest function",
    );
  }

  return client;
};

const executionOf = () => {
  const execution = getAsyncCtxSync()?.execution;

  if (!execution) {
    throw new Error(
      "The agent tools must be called inside an Inngest function",
    );
  }

  return execution;
};

/**
 * The threads sandbox code started in one execution, by key, so that
 * `agent_result` reads the invoke `start()` made: a run that finished first
 * is never missed. A replay starts them again, in the same order, from the
 * journal.
 */
const startedBySandbox = new WeakMap<object, Map<string, StartedThread>>();

const reportsInput = z
  .array(
    z.object({
      type: z.string().describe("The report's type name, such as `milestone`."),
      schema: z
        .any()
        .optional()
        .describe("A JSON Schema of the report's data."),
      required: z
        .boolean()
        .optional()
        .describe(
          "Whether the agent must send this report before it finishes. Default true; set false for a report it may skip.",
        ),
    }),
  )
  .optional()
  .describe(
    'Typed reports the agent should send back to you. Each arrives in your inbox as a `Report "<type>"` message. A type name does not start with `agent/` or `inngest/`.',
  );

const startInput = z.object({
  address: z.string().describe("The agent's address, `app/agent`."),
  input: z
    .any()
    .optional()
    .describe(
      "What to give the agent: the input its card describes, or the text or JSON to send it as a message.",
    ),
  reports: reportsInput,
  attach: z
    .boolean()
    .optional()
    .describe(
      "Whether the agent ends when your run ends. Default false: it carries on by itself, and tells you how it ended if your thread is still there.",
    ),
});

const stopInput = z.object({
  thread: z.string().describe("The thread key `start_agent` returned."),
});

const startAgent = (options: AgentToolSetOptions, via?: "start_agent") => {
  return async ({
    address,
    input,
    reports,
    attach,
  }: {
    address: string;
    input?: Json;
    reports?: { type: string; schema?: JsonSchema; required?: boolean }[];
    attach?: boolean;
  }) => {
    const execution = executionOf();
    const client = clientOf();
    const card = await findCard(address, options, "start");
    const prepared = card.input
      ? await prepareInput(options.discovery, {
          card: publicCardOf(card),
          input: (input ?? {}) as Record<string, Json>,
        })
      : input;

    if (card.input) {
      const problem = checkAgainstSchema(card.input, prepared);

      if (problem) {
        throw new Error(
          `${problem}. "${address}" takes ${JSON.stringify(card.input)}. Nothing was started.`,
        );
      }
    }

    const n = nextCount(execution.instance, "start_agent_status");
    const status = (await step.run(`start_agent:status:${n}`, async () => {
      return startability(client, address, options.functions);
    })) as Awaited<ReturnType<typeof startability>>;

    if (!status.ok) {
      throw new Error(status.reason);
    }

    // The model's reports go back to the model: the starter's own thread.
    let resolved: ReportSpec | undefined;

    if (reports && reports.length > 0) {
      const self = senderOf(execution);

      if (self.kind !== "agent") {
        throw new Error("Only an agent can ask for reports");
      }

      resolved = Object.fromEntries(
        reports.map((report) => {
          if (reservedReportType(report.type)) {
            throw new Error(
              `The report type "${report.type}" is reserved: a type name is not empty, has no "*" and does not start with "agent/" or "inngest/".`,
            );
          }

          return [
            report.type,
            {
              ...(report.schema && { schema: report.schema }),
              // A report the model asks for is owed unless it says otherwise.
              ...(report.required !== false && { required: true as const }),
              to: [{ agent: self.address, thread: self.key }],
            },
          ];
        }),
      );
    }

    const slash = address.indexOf("/");
    const started = await startThread(
      {
        client,
        id: address.slice(slash + 1),
        address,
        typed: card.input !== undefined,
        via,
        ...(resolved && { resolved }),
      },
      card.input ? prepared : (prepared ?? ""),
      attach === undefined ? {} : { attach },
    );

    if (via === "start_agent") {
      trackChild(execution.instance, started.key);
    }

    // What the child owes is kept in this thread's state, which its reports and
    // its end are read against. Sandbox code calls this inside a step's
    // callback, where thread state cannot be written, so the note waits until
    // the run is outside a step.
    const self = execution.agent;

    if (self?.ref && resolved) {
      await noteOwes(
        execution.instance,
        execution.executingStep !== undefined,
        owesRecord(kv.thread, self.ref),
        started.key,
        requiredReports(resolved),
      );
    }

    if (via === undefined) {
      const threads = startedBySandbox.get(execution.instance) ?? new Map();

      threads.set(started.key, started);
      startedBySandbox.set(execution.instance, threads);
    }

    return { thread: started.key };
  };
};

/**
 * Refuses a thread the calling agent may not reach: only its parent (the
 * thread that started it) and its children (threads it started, in any run).
 * The relation is read from the thread keys alone.
 */
const checkReach = (
  tool: string,
  thread: string,
): { address?: string; grant?: Grant } => {
  const execution = executionOf();
  const self = execution.agent;

  if (!self?.ref) {
    throw new Error(`${tool} can only be used by an agent`);
  }

  const reach = relationOf(clientOf(), self.thread, thread);

  if (reach !== undefined) {
    return { address: reach.address };
  }

  // A thread started with a key of its own has no tag, but the grant its
  // start carried names its starter, so the run that start created can reach it.
  const grant = grantOfExecution(execution.instance);

  if (grant?.par && grant.par.key === thread && grant.sub === self.thread) {
    return { address: grant.par.address, grant };
  }

  throw new Error(
    `You can't reach thread "${thread}" with ${tool}. You can reach the thread that started you and threads you started with start_agent, by the thread key start_agent gave you.`,
  );
};

const stopAgent = async ({ thread }: { thread: string }) => {
  // The thread's run record is the target agent's own, whose address starts
  // the key.
  checkReach("stop_agent", thread);

  await threadHandle(
    clientOf(),
    agentOfKey(thread) ?? executionOf().agent?.ref ?? "",
    thread,
  ).stop();

  return { ok: true as const };
};

const messageInput = z.object({
  thread: z.string().describe("The thread key `start_agent` returned."),
  content: z
    .any()
    .describe("The text or JSON to send. The agent reads it as a message."),
});

const askInput = z.object({
  thread: z.string().describe("The thread key `start_agent` returned."),
  question: z.string().describe("The question."),
});

const replyInput = z.object({
  to: z.string().describe("The ID of the question you are answering."),
  text: z.string().describe("Your answer."),
});

/**
 * The agent a thread key belongs to. `start_agent` makes keys that begin with
 * the agent's address; any other key is not one this tool can reach.
 */
const addressOfThread = (thread: string): string => {
  const colon = thread.lastIndexOf(":");
  const address = colon < 0 ? "" : thread.slice(0, colon);

  if (!address.includes("/")) {
    throw new Error(
      `"${thread}" is not a thread key start_agent returned, so no agent can be reached through it.`,
    );
  }

  return address;
};

const messageAgent = async ({
  thread,
  content,
}: {
  thread: string;
  content: Json;
}) => {
  // A parent's address comes from the key that names it; any other thread's
  // agent leads its key.
  const reach = checkReach("message_agent", thread);
  const address = reach.address ?? addressOfThread(thread);
  const { grant } = reach;

  // A message that relies on the grant carries it with a proof made for this
  // message, so a copy of the grant cannot be used for another.
  await sendMessage(clientOf(), address, thread, content, {
    ...(grant && {
      agents: (id: string) => {
        return proofOf(
          clientOf(),
          grant,
          id,
          thread,
          renewalOfExecution(executionOf().instance),
        );
      },
    }),
  });

  return { ok: true as const };
};

const askAgent = async ({
  thread,
  question,
}: {
  thread: string;
  question: string;
}) => {
  const reach = checkReach("ask_agent", thread);
  const agent = reach.address ?? addressOfThread(thread);
  const execution = executionOf();
  const self = execution.agent;

  if (!self?.ref) {
    throw new Error("ask_agent can only be used by an agent");
  }

  const n = nextCount(execution.instance, "ask");
  const id = `ask:${execution.ctx.runId}.${n}`;

  execution.agentBridge?.questions?.ask(id, question);

  // The question and the clock on it go out together. Nothing waits: the
  // answer, or `timed_out`, arrives as an `agent/answer` message.
  await step.sendEvent(`${id}:send`, [
    agentQuestion.create(
      {
        agent,
        thread,
        id,
        text: question,
        from: senderOf(execution),
        ...(reach.grant && {
          "::agents": proofOf(
            clientOf(),
            reach.grant,
            id,
            thread,
            renewalOfExecution(execution.instance),
          ),
        }),
      },
      { meta: { sessions: threadSessions(thread) }, id },
    ),
    agentAskTimeout.create({
      id,
      agent: self.ref,
      thread: self.thread,
      timeout: "1h",
    }),
  ]);

  return { id };
};

const replyTo = async ({ to, text }: { to: string; text: string }) => {
  const questions = executionOf().agentBridge?.questions;
  const found = questions?.question(to);

  if (!questions || !found) {
    throw new Error(
      `No question "${to}" is waiting for you. Answer a question by the ID it came with.`,
    );
  }

  questions.markReplied(to);
  await answerQuestion(clientOf(), found, { text });

  return { ok: true as const };
};

/**
 * What a model reads about `start_agent`.
 */
const startDescription: ToolDescriptionParts = {
  does: "Starts another agent on a new thread to work on its own. It returns the new thread's key at once and does not wait: the agent's reports, questions and final result reach you later as messages.",
  use: "to hand off work that another agent does (`describe_agent` shows the input it takes). Ask for `reports` if you want updates while it works; a report you ask for is required unless you set `required: false`",
  avoid:
    "to wait for an agent: end your turn instead, and its result reaches you as a message",
  context:
    "Agents you start run on their own. Their reports, questions and final results reach you as messages, so you never need to ask them for status: to wait for them, end your turn. A report needs no answer.",
};

/**
 * What sandbox code reads about `start_agent`: code has no inbox, so it
 * waits for a result with `agent_result`.
 */
const codeStartDescription: ToolDescriptionParts = {
  does: "Starts another agent on a new thread and returns at once with the thread's key. It does not wait.",
  use: "to hand off work that another agent does; `describe_agent` shows the input it takes",
  avoid:
    "to get the agent's result: call `agent_result` with the thread key for that",
};

const stopDescription: ToolDescriptionParts = {
  does: "Stops the run of an agent you started, or the agent that started you, by its thread key. You get the agent's outcome as a message.",
  use: "when its work is no longer needed",
  avoid:
    "to end your own turn or to wait: for that, end your turn or call `wait`",
};

const codeStopDescription: ToolDescriptionParts = {
  does: "Stops the run of an agent this code started, by its thread key.",
  use: "when its work is no longer needed",
};

const messageDescription: ToolDescriptionParts = {
  does: "Sends a message to an agent you started, or the agent that started you, by its thread key. It returns at once; any answer comes later as a message.",
  use: "to give new information or change what you asked for",
  avoid:
    "to ask for status, to acknowledge a report, or to send your own final result: results and reports arrive on their own, and your final result goes to whoever started you when you finish",
  context:
    "With `ask_agent` and `stop_agent`, it reaches only the thread that started you and threads you started, by their thread keys. No other thread can be reached.",
};

const askDescription: ToolDescriptionParts = {
  does: "Asks an agent you started, or the agent that started you, a question that needs an answer. It returns the question's ID at once. The answer arrives later as a message that names the ID, or a message saying there was none within an hour.",
  use: "when you can't go on without the answer",
  avoid: "when no answer is needed: use `message_agent` for that",
};

const replyDescription: ToolDescriptionParts = {
  does: "Answers a question another agent asked you, by the question's ID. It returns at once.",
  use: "only for a question that arrived with an ID and has no answer yet",
  avoid:
    "to send your result, a report or an update: your result reaches whoever started you when you finish, and reports go through `report`",
};

const okOutput = z.object({ ok: z.literal(true) });
const threadOutput = z.object({ thread: z.string() });

/**
 * `start_agent` and `stop_agent` for a model.
 *
 * - `start_agent({ address, input? })`: checks the agent can be started (not
 *   paused, archived or gone) and that `input` fits the card's `input`, then
 *   starts it on a new thread and returns `{ thread }` without waiting. An
 *   agent without an `invoke()` trigger takes `input` as the content of an
 *   `agent/message`. When the run ends, the model gets an `agent/finished`
 *   message.
 * - `stop_agent({ thread })`: cancels the run of a thread started with
 *   `start_agent`; the model then gets an `agent/finished` message with
 *   outcome `stopped`.
 */
export const agentToolSet = (
  options: AgentToolSetOptions = {},
): AgentActionToolSet => {
  // The `input` of start_agent is `z.any()` so that it is any text or JSON; its
  // type is written out above.
  return {
    start_agent: tool({
      id: "start_agent",
      description: startDescription,
      group: true,
      input: startInput,
      output: threadOutput,
      run: startAgent(options, "start_agent"),
    }),
    ...relativeTools,
    reply: replyTool,
  };
};

/**
 * `message_agent`, `ask_agent` and `stop_agent`: the tools that reach the
 * threads related to the caller's (its starter and its children).
 */
const relativeTools = {
  message_agent: tool({
    id: "message_agent",
    description: messageDescription,
    group: true,
    input: messageInput,
    output: okOutput,
    run: messageAgent,
  }),
  ask_agent: tool({
    id: "ask_agent",
    description: askDescription,
    group: true,
    input: askInput,
    output: z.object({ id: z.string() }),
    run: askAgent,
  }),
  stop_agent: tool({
    id: "stop_agent",
    description: stopDescription,
    group: true,
    input: stopInput,
    output: okOutput,
    run: stopAgent,
  }),
};

/**
 * `reply({ to, text })`: answers a question that reached the agent, by the
 * ID it came with. A model agent gets it once a question reaches its run,
 * whatever its `discovery`, and keeps it for the rest of the run.
 */
export const replyTool: AgentToolSet["reply"] = tool({
  id: "reply",
  description: replyDescription,
  group: true,
  input: replyInput,
  output: okOutput,
  run: replyTo,
});

/**
 * What the model reads for `wait` in the SDK's own handler, which wakes the
 * model for the next message.
 */
export const waitDescription: ToolDescriptionParts = {
  does: "Ends your turn on purpose. You are woken when the next message arrives.",
  use: "when you have nothing to do until a message arrives, such as while agents you started are working",
  avoid:
    "to end a turn by calling some other tool: a reply without a tool call also ends your turn",
};

/**
 * What the model reads for `wait` in a handler of the agent's own, whose code
 * decides whether the model runs again.
 */
export const handlerWaitDescription: ToolDescriptionParts = {
  does: "Ends your turn on purpose. Your last text goes back to your agent's code.",
  use: "when you have nothing more to do",
};

/**
 * What `wait` gives back, kept in the history as the call's result.
 */
export const waitResult = "Waiting. You'll be woken when a message arrives.";

/**
 * EXPERIMENTAL: `wait({ reason? })`: ends the model's turn on purpose. Once it
 * and the other calls of the same reply have run, the loop ends as it does on
 * a reply with no tool call, and the run waits for its next message as it
 * already does. Its result is a constant, so it costs no step and replays the
 * same. Every model agent's loop has it; a tool of yours named `wait` replaces
 * it.
 */
const makeWait = (description: ToolDescriptionParts, result: string) => {
  return endsTurn(
    tool({
      id: "wait",
      description,
      group: true,
      input: z.object({
        reason: z
          .string()
          .optional()
          .describe("Why you are waiting, in a few words."),
      }),
      run: async () => {
        return result;
      },
    }) as unknown as AgentTool<{ reason?: string }, string>,
  );
};

export const waitTool = makeWait(waitDescription, waitResult);

/**
 * `wait` for a handler of the agent's own: the same tool, with a description
 * that promises no wake-up.
 */
export const handlerWaitTool = makeWait(handlerWaitDescription, "Turn ended.");

/**
 * The agent tools a model agent starts a run with. Discovery is opt-in: a
 * `discovery` of `true` or options gives `list_agents`, `describe_agent`,
 * `start_agent`, `message_agent`, `ask_agent` and `stop_agent`. Without it,
 * a run another agent started still gets
 * `message_agent`, `ask_agent` and `stop_agent`, which reach only its
 * relatives. `reply` is not here: the loop adds it once a question arrives.
 * @param discovery The definition's `discovery`.
 * @param related Whether the thread has relatives to reach (a starting
 * agent).
 */
export const agentToolsFor = (
  discovery: AgentDiscovery | undefined,
  related = false,
): Record<string, AgentTool> => {
  if (!discoveryOptionsOf(discovery)) {
    return related ? { ...relativeTools } : {};
  }

  const { reply: _reply, ...actions } = agentToolSet({ discovery });

  return { ...discoveryToolSet({ discovery }), ...actions };
};

/**
 * The tools sandbox code gets: `start_agent` and `stop_agent` as for a model,
 * plus `agent_result({ thread })`, which waits for the run to end and gives
 * `{ outcome, output | error }`. It waits (the script exits and runs again from
 * its journal) on the invoke that started the run, so a run that finished
 * first is never missed.
 */
export const sandboxAgentTools = (
  options: AgentToolSetOptions = {},
): Record<"start_agent" | "stop_agent" | "agent_result", SandboxTool> => {
  return {
    start_agent: tool.group({
      description: codeStartDescription,
      input: startInput,
      output: threadOutput,
      run: startAgent(options),
    }),
    stop_agent: tool.group({
      description: codeStopDescription,
      input: stopInput,
      output: okOutput,
      run: stopAgent,
    }),
    agent_result: tool.group({
      description: {
        does: "Waits for an agent this code started to finish and gives its outcome: `completed` with `output`, `failed` with `error`, or `stopped`.",
        use: "once the code needs the agent's result",
      },
      input: z.object({
        thread: z.string().describe("The thread key `start_agent` returned."),
      }),
      output: z.union([
        z.object({
          outcome: z.literal("completed"),
          output: z.any().optional(),
        }),
        z.object({ outcome: z.literal("failed"), error: z.string() }),
        z.object({ outcome: z.literal("stopped") }),
      ]),
      waits: true,
      run: async ({ thread }: { thread: string }) => {
        const started = startedBySandbox
          .get(executionOf().instance)
          ?.get(thread);

        if (!started) {
          throw new Error(
            `This script did not start a thread "${thread}" with start_agent.`,
          );
        }

        try {
          const output = await started.result();

          return {
            outcome: "completed" as const,
            ...(output !== undefined && { output: output as Json }),
          };
        } catch (error) {
          if (error instanceof AgentStoppedError) {
            return { outcome: "stopped" as const };
          }

          return {
            outcome: "failed" as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    }),
  };
};

/**
 * The agent tools sandbox code gets in a `runCode` the agent lists, with no
 * setup: `list_agents`, `describe_agent`, `start_agent`, `message_agent`,
 * `stop_agent` and the waiting `agent_result`. They follow the agent's
 * `discovery` as the model's do, and `false` gives none. `ask_agent` and
 * `reply` are the model's alone: their answers arrive as messages, and code
 * has no inbox. A run that owes reports also gives code `report`, whatever
 * its `discovery` (see `codeReportTool`).
 */
export const codeAgentTools = (
  discovery: AgentDiscovery | undefined,
): Record<string, SandboxTool> => {
  if (!discoveryOptionsOf(discovery)) {
    return {};
  }

  const options = { discovery };

  return {
    ...discoveryToolSet(options),
    message_agent: agentToolSet(options).message_agent,
    ...sandboxAgentTools(options),
  } as Record<string, SandboxTool>;
};
