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

  return {
    agent: (config, body) => {
      const created = createAgentFunction(client, config, body);

      made.push(created);

      return created;
    },
    functions: () => {
      return made.flatMap((created) => {
        return [created.fn, created.cleanup];
      });
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
  KvScope,
  KvScopeInstance,
} from "./kv.ts";
export { createKv, kv, memoryKvAdapter, redisKvAdapter } from "./kv.ts";
export type {
  SlackChannelOptions,
  SlackMessageData,
  SlackTarget,
} from "./slack.ts";
export { slack } from "./slack.ts";
export type {
  InboxMessage,
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
