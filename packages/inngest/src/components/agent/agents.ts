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
import { definitionOf } from "./defs.ts";
import {
  allowBake,
  allowDynamicBake,
  type BakeAllowance,
  bakeAllowanceOf,
  createSkillsBakeFunction,
} from "./skills.ts";
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
   * cleanup. Call it after the agents are defined. The function that bakes
   * skills snapshots is one per client, however many `createAgents()` calls it
   * has: an instance with an agent that may bake lists it, so serving
   * any one of them is enough. Spreading the lists of several such instances
   * together repeats it (drop repeats by `id`). One client
   * instance per app ID: two clients with the same ID each have a bake
   * function with the same function ID.
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
    return (definitionOf(binding).skills ?? []).some((source) => {
      return source.freshness === "bake";
    });
  });
};

const allowBakes = (
  allowance: BakeAllowance,
  agent: string,
  sandboxes: AgentFunctionConfig["sandboxes"],
): void => {
  if (typeof sandboxes === "function") {
    allowDynamicBake(allowance, agent);

    return;
  }

  for (const binding of Object.values(sandboxes ?? {})) {
    allowBake(allowance, agent, definitionOf(binding));
  }
};

/**
 * The bake function of each client: one, however many `createAgents()` calls
 * the client has.
 */
const bakeFunctions = new WeakMap<object, InngestFunction.Any>();

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
  const allowance = bakeAllowanceOf(client);
  let bakes = false;

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
        bakes = true;

        if (!bakeFunctions.has(client)) {
          bakeFunctions.set(
            client,
            createSkillsBakeFunction(client, allowance),
          );
        }
      }

      allowBakes(allowance, created.ref, config.sandboxes);

      return created;
    },
    functions: () => {
      const functions = made.flatMap((created) => {
        return [created.fn, created.cleanup];
      });
      const shared = bakeFunctions.get(client);

      return bakes && shared ? [...functions, shared] : functions;
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
export { agentMessage } from "./events.ts";
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
export { skills, skillsBake } from "./skills.ts";
export type {
  SlackChannelOptions,
  SlackMessageData,
  SlackTarget,
} from "./slack.ts";
export { slack } from "./slack.ts";
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
export { agentMessageEvent, getThread } from "./thread.ts";
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
