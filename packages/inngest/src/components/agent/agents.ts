/**
 * @module
 * EXPERIMENTAL: the agent layer exported from `inngest/experimental/agents`.
 * `createAgents(client)` makes the agents of one client and remembers the
 * functions they need served, so the app passes `agents.functions()` to
 * `serve()` or `connect()` the way `@inngest/ci` passes `ci.functions()`.
 */

import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import type { EventTypeWithAnySchema } from "../triggers/triggers.ts";
import {
  type AgentBody,
  type AgentFunction,
  type AgentFunctionConfig,
  createAgentFunction,
} from "./agentFunction.ts";
import type { SandboxDefinition } from "./defs.ts";
import { createSkillsBakeFunction } from "./skills.ts";
import type {
  ThreadCronTrigger,
  ThreadEventTrigger,
  ThreadTriggerEventSource,
  ThreadTriggerList,
} from "./threadTrigger.ts";

export interface Agents {
  /**
   * Defines an agent: a function whose body owns its loop and reads a
   * durable inbox.
   * @param config Function ID and KV store.
   * @param body Your loop. Read `inbox`, call `agent.loop()` with `control`.
   */
  agent<const TOne extends ThreadTriggerEventSource>(
    config: AgentFunctionConfig<
      ThreadEventTrigger<TOne> | EventTypeWithAnySchema<string>
    >,
    body: AgentBody,
  ): AgentFunction;
  agent(
    config: AgentFunctionConfig<ThreadCronTrigger>,
    body: AgentBody,
  ): AgentFunction;
  agent<const TMany extends readonly unknown[]>(
    config: AgentFunctionConfig<ThreadTriggerList<TMany>>,
    body: AgentBody,
  ): AgentFunction;

  /**
   * Every function to pass to `serve()`: each agent's function and its
   * cleanup. Call it after the agents are defined.
   *
   * ```ts
   * export const { GET, POST, PUT } = serve({
   *   client: inngest,
   *   functions: agents.functions(),
   * });
   * ```
   */
  functions(): InngestFunction.Any[];
}

const mayBakeSkills = (
  sandboxes: AgentFunctionConfig["sandboxes"],
): boolean => {
  if (!sandboxes) {
    return false;
  }

  if (typeof sandboxes === "function") {
    return true;
  }

  return Object.values(sandboxes).some((binding) => {
    const definition =
      "sandbox" in binding ? binding.sandbox : (binding as SandboxDefinition);

    return (definition.skills ?? []).some((source) => {
      return source.freshness === "bake";
    });
  });
};

/**
 * EXPERIMENTAL: Makes the agents of one Inngest client.
 *
 * ```ts
 * const agents = createAgents(inngest);
 *
 * export const support = agents.agent({ id: "support" }, async ({ inbox }) => {
 *   // ...
 * });
 * ```
 *
 * @param client Inngest client.
 */
export const createAgents = (client: Inngest.Any): Agents => {
  const made: AgentFunction[] = [];
  let bake: InngestFunction.Any | undefined;

  return {
    agent: (config: AgentFunctionConfig<unknown>, body: AgentBody) => {
      const created = createAgentFunction(
        client,
        config as AgentFunctionConfig,
        body,
      );

      made.push(created);

      // Baked skills are built by a function of its own, served once however
      // many agents there are. A sandboxes config that is a function can't be
      // read ahead, so it counts as possibly having skills.
      if (mayBakeSkills(config.sandboxes)) {
        bake ??= createSkillsBakeFunction(client);
      }

      return created;
    },
    functions: () => {
      const functions = made.flatMap((created) => {
        return [created.fn, created.cleanup];
      });

      return bake ? [...functions, bake] : functions;
    },
  };
};

export type {
  AgentBody,
  AgentBodyContext,
  AgentFunction,
  AgentFunctionConfig,
  ThreadInbox,
  ThreadInboxMessage,
} from "./agentFunction.ts";
export type { ThreadStop } from "./events.ts";
export { agentMessage, agentStop } from "./events.ts";
export type {
  Kv,
  KvAdapter,
  KvHandle,
  KvIndex,
  KvIndexEntry,
  KvIndexRange,
  KvScope,
  KvScopeInstance,
  KvSetOptions,
} from "./kv.ts";
export { createKv, kv, memoryKvAdapter, redisKvAdapter } from "./kv.ts";
export type { SkillsGitOptions, SkillsSource } from "./skills.ts";
export { skills, skillsBake } from "./skills.ts";
export type {
  InboxMessage,
  SubscribeData,
  SubscribeEvent,
  SubscribeOptions,
  Subscription,
} from "./subscribe.ts";
export type {
  RequestOptions,
  ThreadHandle,
  ThreadMessage,
  ThreadOptions,
  ThreadState,
  ThreadStatus,
} from "./thread.ts";
export { agentMessageEvent, agentStopEvent, getThread } from "./thread.ts";
export type {
  InsightsQuery,
  ThreadList,
  ThreadListOptions,
} from "./threadList.ts";
export { listThreads } from "./threadList.ts";
export type {
  ThreadCronTrigger,
  ThreadEventTrigger,
  ThreadKeyConfig,
  ThreadTrigger,
  ThreadTriggerData,
  ThreadTriggerEvent,
  ThreadTriggerEventSource,
  ThreadTriggerList,
  ThreadTriggers,
} from "./threadTrigger.ts";
