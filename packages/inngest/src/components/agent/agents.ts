/**
 * @module
 * EXPERIMENTAL: the agent layer exported from `inngest/experimental/agents`.
 * `createAgents(client)` makes the agents of one client and remembers the
 * functions they need served, so the app passes `agents.functions()` to
 * `serve()` or `connect()` the way `@inngest/ci` passes `ci.functions()`.
 */

import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import {
  type AgentBody,
  type AgentFunction,
  type AgentFunctionConfig,
  createAgentFunction,
} from "./agentFunction.ts";
import type { SandboxDefinition } from "./defs.ts";
import { createSkillsBakeFunction } from "./skills.ts";

export interface Agents {
  /**
   * Defines an agent: a function whose body owns its loop and reads a
   * durable inbox.
   * @param config Function ID and KV store.
   * @param body Your loop. Read `inbox`, call `agent.loop()` with `control`.
   */
  agent(config: AgentFunctionConfig, body: AgentBody): AgentFunction;

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
    agent: (config, body) => {
      const created = createAgentFunction(client, config, body);

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
export type {
  Channel,
  ChannelAsk,
  ChannelMessage,
  ChannelTrigger,
  ReportConfig,
  ReportConfigValue,
  Reporter,
  ReportTarget,
} from "./channels.ts";
export { askThrough, defineChannel } from "./channels.ts";
export type {
  GithubChannelOptions,
  GithubCommentData,
  GithubTarget,
} from "./github.ts";
export { github } from "./github.ts";
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
export { skills } from "./skills.ts";
export type {
  SlackChannelOptions,
  SlackMessageData,
  SlackTarget,
} from "./slack.ts";
export { slack } from "./slack.ts";
export type {
  InboxMessage,
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
  ThreadKeyConfig,
  ThreadTrigger,
  ThreadTriggerEvent,
} from "./threadTrigger.ts";
