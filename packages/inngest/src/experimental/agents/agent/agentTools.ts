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
import type { Json } from "../json.ts";
import { threadHandle } from "../threads/thread.ts";
import { nextCount } from "./executionCounter.ts";
import { AgentStoppedError } from "./runResults.ts";
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
  start_agent: AgentTool;
  stop_agent: AgentTool;
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
  return {
    start_agent: tool({
      id: "start_agent",
      description: `${startDescription} When the agent finishes you get its outcome as a message.`,
      group: true,
      input: startInput,
      run: startAgent(options, "start_agent"),
    }),
    stop_agent: tool({
      id: "stop_agent",
      description: `${stopDescription} You get its outcome as a message.`,
      group: true,
      input: stopInput,
      run: stopAgent,
    }),
  };
};

/**
 * The tools a model agent gets by default, from its definition's `discovery`
 * field: `list_agents`, `describe_agent`, `start_agent` and `stop_agent`, and
 * none for `false`.
 */
export const agentToolsFor = (
  discovery: AgentDiscovery | undefined,
): Record<string, AgentTool> => {
  if (discovery === false) {
    return {};
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
