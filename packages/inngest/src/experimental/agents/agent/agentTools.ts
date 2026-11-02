/**
 * @module
 * EXPERIMENTAL: the agent tools a model gets to work with other agents. None
 * of them waits: `start_agent` returns the new thread's key at once, and what
 * comes back (the end of the run, a question, an answer) reaches the model as
 * a message in its inbox. A model agent can therefore never deadlock on
 * another agent.
 *
 * - `start_agent({ address, input? })`: starts an agent on a new thread.
 * - `stop_agent({ thread })`: stops the run of a thread the model started.
 *
 * Sandbox code gets the same two plus `agent_result({ thread })`, which waits
 * for the run's end: code waits, so nothing it started lands in an inbox.
 */

import { z } from "zod/v4";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import {
  type AgentTool,
  type SandboxTool,
  tool,
} from "../../../components/sandbox/tools.ts";
import {
  type AgentDiscovery,
  type DiscoveryToolSetOptions,
  discoveryToolSet,
  findCard,
  prepareInput,
} from "../discovery/discovery.ts";
import { startability } from "../discovery/functions.ts";
import { checkAgainstSchema } from "../discovery/inputCheck.ts";
import { answerQuestion } from "../inbox/answer.ts";
import { agentAskTimeout, agentQuestion } from "../inbox/events.ts";
import type { Json } from "../json.ts";
import { threadHandle, threadSessions } from "../threads/thread.ts";
import { nextCount } from "./executionCounter.ts";
import { AgentStoppedError } from "./runResults.ts";
import { senderOf } from "./sender.ts";
import { type StartedThread, startThread } from "./startThread.ts";

/**
 * Options of the agent tools.
 */
export interface AgentToolSetOptions extends DiscoveryToolSetOptions {
  /**
   * The definition's `discovery` field, whose `prepare` fills part of the
   * input of a call to another agent.
   */
  discovery?: AgentDiscovery;
}

/**
 * The tools that start and stop agents.
 */
export type AgentToolSet = {
  start_agent: AgentTool<{ address: string; input?: Json }, { thread: string }>;
  message_agent: AgentTool<{ thread: string; content: Json }, { ok: true }>;
  ask_agent: AgentTool<{ thread: string; question: string }, { id: string }>;
  stop_agent: AgentTool<{ thread: string }, { ok: true }>;
  reply: AgentTool<{ to: string; text: string }, { ok: true }>;
};

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

const startInput = z.object({
  address: z.string().describe("The agent's address, `app/agent`."),
  input: z
    .any()
    .optional()
    .describe(
      "What to give the agent: the input its card describes, or the text or JSON to send it as a message.",
    ),
});

const stopInput = z.object({
  thread: z.string().describe("The thread key `start_agent` returned."),
});

const startAgent = (options: AgentToolSetOptions, via?: "start_agent") => {
  return async ({ address, input }: { address: string; input?: Json }) => {
    const execution = executionOf();
    const client = clientOf();
    const card = await findCard(address, options);
    const prepared = card.input
      ? await prepareInput(options.discovery, {
          card,
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

    const slash = address.indexOf("/");
    const started = await startThread(
      {
        client,
        id: address.slice(slash + 1),
        address,
        typed: card.input !== undefined,
        via,
      },
      card.input ? prepared : (prepared ?? ""),
    );

    if (via === undefined) {
      const threads = startedBySandbox.get(execution.instance) ?? new Map();

      threads.set(started.key, started);
      startedBySandbox.set(execution.instance, threads);
    }

    return { thread: started.key };
  };
};

const stopAgent = async ({ thread }: { thread: string }) => {
  await threadHandle(clientOf(), executionOf().agent?.ref ?? "", thread).stop();

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
  await threadHandle(clientOf(), addressOfThread(thread), thread).message(
    content,
  );

  return { ok: true as const };
};

const askAgent = async ({
  thread,
  question,
}: {
  thread: string;
  question: string;
}) => {
  const agent = addressOfThread(thread);
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
      { agent, thread, id, text: question, from: senderOf(execution) },
      { meta: { sessions: threadSessions(thread) } },
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

const startDescription =
  "Starts another agent on a new thread and returns at once with the thread's key. It does not wait. Use describe_agent to see what input it takes.";
const stopDescription = "Stops the run of an agent you started.";

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
): AgentToolSet => {
  // The `input` of start_agent is `z.any()` so that it is any text or JSON; its
  // type is written out above.
  return {
    start_agent: tool({
      id: "start_agent",
      description: `${startDescription} When the agent finishes you get its outcome as a message.`,
      group: true,
      input: startInput,
      run: startAgent(options, "start_agent"),
    }),
    message_agent: tool({
      id: "message_agent",
      description:
        "Sends a message to an agent you started. It does not wait for a reply.",
      group: true,
      input: messageInput,
      run: messageAgent,
    }),
    ask_agent: tool({
      id: "ask_agent",
      description:
        "Asks an agent you started a question and returns the question's ID at once. The answer arrives later as a message that names the ID; if there is none within an hour, you get a message that says so.",
      group: true,
      input: askInput,
      run: askAgent,
    }),
    stop_agent: tool({
      id: "stop_agent",
      description: `${stopDescription} You get its outcome as a message.`,
      group: true,
      input: stopInput,
      run: stopAgent,
    }),
    reply: replyTool,
  };
};

/**
 * `reply({ to, text })`: answers a question that reached the agent, by the
 * ID it came with. It is not a discovery tool: a model agent always has it,
 * even with `discovery: false`.
 */
export const replyTool: AgentToolSet["reply"] = tool({
  id: "reply",
  description:
    "Answers a question another agent asked you, by the question's ID.",
  group: true,
  input: replyInput,
  run: replyTo,
});

/**
 * The tools a model agent gets by default, from its definition's `discovery`
 * field: `list_agents`, `describe_agent`, `start_agent` and `stop_agent`, and
 * none for `false`.
 */
export const agentToolsFor = (
  discovery: AgentDiscovery | undefined,
): Record<string, AgentTool> => {
  if (discovery === false) {
    return { reply: replyTool };
  }

  return {
    ...discoveryToolSet(),
    ...agentToolSet({ discovery }),
  };
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
      description: startDescription,
      input: startInput,
      run: startAgent(options),
    }),
    stop_agent: tool.group({
      description: stopDescription,
      input: stopInput,
      run: stopAgent,
    }),
    agent_result: tool.group({
      description:
        "Waits for an agent you started to finish and gives its outcome: `completed` with `output`, `failed` with `error`, or `stopped`.",
      input: z.object({
        thread: z.string().describe("The thread key `start_agent` returned."),
      }),
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
