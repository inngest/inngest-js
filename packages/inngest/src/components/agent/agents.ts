// biome-ignore-all lint/suspicious/noExplicitAny: the overloads type the config and body; the implementation accepts any of them

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
import { definitionOf, type SandboxToolNames } from "./defs.ts";
import {
  allowBake,
  allowDynamicBake,
  type BakeAllowance,
  bakeAllowanceOf,
  createSkillsBakeFunction,
} from "./skills.ts";
import type {
  ThreadCronEvent,
  ThreadCronTrigger,
  ThreadEventTrigger,
  ThreadTriggerEventOf,
  ThreadTriggerEventSource,
  ThreadTriggerList,
  ThreadTriggerListEvent,
} from "./threadTrigger.ts";

/**
 * What an agent without `sandboxes` has: none, so `sandboxes.anything` and
 * `sandboxTools.anything` fail to compile.
 */
type NoSandboxes = Record<never, never>;

export interface Agents {
  /**
   * Defines an agent: a function whose body owns its loop and reads a
   * durable inbox.
   * @param config Function ID and KV store.
   * @param body Your loop. Read `inbox`, call `agent.loop()` with `control`.
   */
  agent<
    TType extends EventTypeWithAnySchema<string>,
    TOutput = unknown,
    TRequest = unknown,
    TReply = unknown,
    TSandboxes extends SandboxToolNames = NoSandboxes,
  >(
    config: AgentFunctionConfig<
      TType,
      ThreadTriggerEventOf<TType>,
      TRequest,
      TReply,
      TSandboxes
    >,
    body: AgentBody<
      ThreadTriggerEventOf<TType>,
      TOutput,
      TRequest,
      TReply,
      TSandboxes
    >,
  ): AgentFunction<
    InvokeInput<ThreadTriggerEventOf<TType>>,
    TOutput,
    TRequest,
    TReply
  >;
  agent<
    const TTypes extends readonly EventTypeWithAnySchema<string>[],
    TOutput = unknown,
    TRequest = unknown,
    TReply = unknown,
  >(
    config: AgentFunctionConfig<
      TTypes,
      ThreadTriggerListEvent<TTypes>,
      TRequest,
      TReply
    >,
    body: AgentBody<ThreadTriggerListEvent<TTypes>, TOutput, TRequest, TReply>,
  ): AgentFunction<
    InvokeInput<ThreadTriggerListEvent<TTypes>>,
    TOutput,
    TRequest,
    TReply
  >;
  agent<
    const TOne extends ThreadTriggerEventSource,
    TOutput = unknown,
    TRequest = unknown,
    TReply = unknown,
    TSandboxes extends SandboxToolNames = NoSandboxes,
  >(
    config: AgentFunctionConfig<
      ThreadEventTrigger<TOne> | (TOne & EventTypeWithAnySchema<string>),
      ThreadTriggerEventOf<TOne>,
      TRequest,
      TReply,
      TSandboxes
    >,
    body: AgentBody<
      ThreadTriggerEventOf<TOne>,
      TOutput,
      TRequest,
      TReply,
      TSandboxes
    >,
  ): AgentFunction<
    InvokeInput<ThreadTriggerEventOf<TOne>>,
    TOutput,
    TRequest,
    TReply
  >;
  agent<
    TOutput = unknown,
    TRequest = unknown,
    TReply = unknown,
    TSandboxes extends SandboxToolNames = NoSandboxes,
  >(
    config: AgentFunctionConfig<
      ThreadCronTrigger,
      ThreadCronEvent,
      TRequest,
      TReply,
      TSandboxes
    >,
    body: AgentBody<ThreadCronEvent, TOutput, TRequest, TReply, TSandboxes>,
  ): AgentFunction<Record<string, unknown>, TOutput, TRequest, TReply>;
  agent<
    const TMany extends readonly unknown[],
    TOutput = unknown,
    TRequest = unknown,
    TReply = unknown,
    TSandboxes extends SandboxToolNames = NoSandboxes,
  >(
    config: AgentFunctionConfig<
      ThreadTriggerList<TMany>,
      ThreadTriggerListEvent<TMany>,
      TRequest,
      TReply,
      TSandboxes
    >,
    body: AgentBody<
      ThreadTriggerListEvent<TMany>,
      TOutput,
      TRequest,
      TReply,
      TSandboxes
    >,
  ): AgentFunction<
    InvokeInput<ThreadTriggerListEvent<TMany>>,
    TOutput,
    TRequest,
    TReply
  >;

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

/**
 * What `agent.invoke(agent, input)` takes: the data of the agent's
 * `invoke()` triggers, or any record for an agent without one.
 */
export type InvokeInput<TEvent> = [
  Extract<TEvent, { name: "inngest/function.invoked" }>,
] extends [never]
  ? Record<string, unknown>
  : DataOf<Extract<TEvent, { name: "inngest/function.invoked" }>>;

type DataOf<T> = T extends { data: infer TData } ? TData : never;

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
    agent: (
      config: AgentFunctionConfig<unknown, any>,
      body: AgentBody<any>,
    ) => {
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
  GithubThreadOptions,
} from "./github.ts";
export { github, githubCommentEvent } from "./github.ts";
export type {
  Kv,
  KvAdapter,
  KvIndex,
  KvIndexEntry,
  KvIndexRange,
  KvKey,
  KvKeyInput,
  KvRoundTrips,
  KvSchemaMustRoundTrip,
  KvScope,
  KvScopeInstance,
  KvSetOptions,
  KvValue,
} from "./kv.ts";
export {
  createKv,
  kv,
  kvKey,
  memoryKvAdapter,
  redisKvAdapter,
} from "./kv.ts";
export type { SkillsGitOptions, SkillsSource } from "./skills.ts";
export { skills, skillsBake } from "./skills.ts";
export type {
  SlackChannelOptions,
  SlackMessageData,
  SlackTarget,
  SlackThreadOptions,
} from "./slack.ts";
export { slack, slackMessageEvent } from "./slack.ts";
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
  ThreadRequestMessage,
  ThreadRequests,
  ThreadState,
  ThreadStatus,
  ThreadSteerMessage,
  ThreadStopMessage,
  ThreadUserMessage,
} from "./thread.ts";
export { agentMessageEvent, getThread } from "./thread.ts";
export type {
  InsightsQuery,
  ThreadList,
  ThreadListOptions,
} from "./threadList.ts";
export { listThreads } from "./threadList.ts";
export type {
  ThreadCronEvent,
  ThreadCronTrigger,
  ThreadEventTrigger,
  ThreadKeyConfig,
  ThreadTrigger,
  ThreadTriggerData,
  ThreadTriggerEvent,
  ThreadTriggerEventOf,
  ThreadTriggerEventSource,
  ThreadTriggerList,
  ThreadTriggerListEvent,
  ThreadTriggers,
} from "./threadTrigger.ts";
