/**
 * @module
 * EXPERIMENTAL: An agent as a tool. An agent goes straight into the `tools`
 * of `agent.loop()`, or anywhere else tools are accepted, and a call to it
 * starts the agent and waits for its result, as `agent.invoke()` does.
 */

import * as z from "zod/v4";
import type { InngestFunction } from "../InngestFunction.ts";
import {
  type AgentTool,
  type SandboxTool,
  triggerSchema,
} from "../sandbox/tools.ts";
import { invokeAgent } from "./invoke.ts";

/**
 * What the model passes to an agent that takes no typed input: the text the
 * agent reads as a message. An agent with a typed `invoke()` trigger takes
 * that trigger's data instead.
 */
export interface AgentMessageInput {
  /**
   * What to tell the agent.
   */
  message: string;
}

/**
 * What a call to the agent `TInput` takes as a tool: its `invoke()` data when
 * it declares one, else `{ message }`.
 */
export type AgentToolInput<TInput> = Record<string, unknown> extends TInput
  ? AgentMessageInput
  : TInput;

const messageInput = z.object({
  message: z.string().describe("What to tell the agent."),
});

/**
 * The name of an agent as a tool: its ID with every character a tool name
 * cannot hold turned into an underscore.
 */
export const agentToolName = (
  /**
   * The agent's function ID.
   */
  id: string,
): string => {
  const safe = id.replace(/[^A-Za-z0-9_]/g, "_");
  const named = /^[A-Za-z]/.test(safe) ? safe : `agent_${safe}`;

  return named.slice(0, 64);
};

/**
 * Makes the tool an agent carries. A call hands the agent its input and waits
 * for its result, through the same step as `agent.invoke()`.
 */
export const agentToolOf = (
  /**
   * The agent's address, `"<appId>/<functionId>"`.
   */
  ref: string,

  /**
   * The agent's function ID.
   */
  id: string,

  /**
   * The agent's function, whose triggers say what a typed agent takes.
   */
  fn: InngestFunction.Any,

  /**
   * The agent's `description`.
   */
  description: string | undefined,
): AgentTool => {
  const typed = triggerSchema(fn, true);
  const text =
    description ??
    `Hands a task to the ${id} agent and returns what it answers.`;

  // A plain agent reads its input as a message to its thread, the same event
  // `thread.send()` makes. The thread is the one the call chose.
  const tool: SandboxTool = typed
    ? {
        group: true,
        description: text,
        input: typed,
        run: (input: Record<string, unknown>) => {
          return invokeAgent({ ref }, input, {}, true);
        },
      }
    : {
        group: true,
        description: text,
        input: messageInput,
        run: ({ message }: AgentMessageInput) => {
          return invokeAgent(
            { ref },
            (thread) => {
              return { agent: ref, thread, text: message };
            },
            {},
            true,
          );
        },
      };

  return Object.freeze({
    ...tool,
    kind: "inngest/tool" as const,
    id: agentToolName(id),
  });
};
