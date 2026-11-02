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
 */

import { z } from "zod/v4";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { type AgentTool, tool } from "../../../components/sandbox/tools.ts";
import {
  type AgentDiscovery,
  type DiscoveryToolSetOptions,
  findCard,
  prepareInput,
} from "../discovery/discovery.ts";
import { startability } from "../discovery/functions.ts";
import { checkAgainstSchema } from "../discovery/inputCheck.ts";
import type { Json } from "../json.ts";
import { getThread } from "../threads/thread.ts";
import { nextCount } from "./executionCounter.ts";
import { startThread } from "./startThread.ts";

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
 * `start_agent` and `stop_agent`.
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
      description:
        "Starts another agent on a new thread and returns at once with the thread's key. It does not wait: when the agent finishes you get its outcome as a message. Use describe_agent to see what input it takes.",
      input: z.object({
        address: z.string().describe("The agent's address, `app/agent`."),
        input: z
          .any()
          .optional()
          .describe(
            "What to give the agent: the input its card describes, or the text or JSON to send it as a message.",
          ),
      }),
      run: async ({ address, input }: { address: string; input?: Json }) => {
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
            via: "start_agent",
          },
          card.input ? prepared : (prepared ?? ""),
        );

        return { thread: started.key };
      },
    }),
    stop_agent: tool({
      id: "stop_agent",
      description:
        "Stops the run of an agent you started. You get its outcome as a message.",
      input: z.object({
        thread: z.string().describe("The thread key `start_agent` returned."),
      }),
      run: async ({ thread }: { thread: string }) => {
        const execution = executionOf();
        const client = clientOf();

        await getThread(client, execution.agent?.ref ?? "", thread).stop();

        return { ok: true as const };
      },
    }),
  };
};
