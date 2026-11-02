// biome-ignore-all lint/suspicious/noExplicitAny: the overloads type the config and body; the implementation accepts any of them

/**
 * @module
 * EXPERIMENTAL: the agent layer exported from `inngest/experimental/agents`.
 * `createAgents(client)` makes the agents of one client and remembers the
 * functions they need served, so the app passes `agents.functions()` to
 * `serve()` or `connect()` the way `@inngest/ci` passes `ci.functions()`.
 */

import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import type { Middleware } from "../../../components/middleware/middleware.ts";
import type { EventTypeWithAnySchema } from "../../../components/triggers/triggers.ts";
import {
  agentsAnnounceEvent,
  announcement,
  rememberCard,
} from "../discovery/discovery.ts";
import type { InboxToolsConfig } from "../inbox/inboxTools.ts";
import { type KvStore, setAppKvStore } from "../kv/kv.ts";
import type { SandboxToolNames } from "../sandboxes/defs.ts";
import type {
  ThreadCronEvent,
  ThreadCronTrigger,
  ThreadEventTrigger,
  ThreadTriggerEventOf,
  ThreadTriggerEventSource,
  ThreadTriggerList,
  ThreadTriggerListEvent,
} from "../threads/threadTrigger.ts";
import { createAgentFunction } from "./agentFunction.ts";
import type {
  AgentBody,
  AgentBodyContext,
  AgentFunction,
  AgentFunctionConfig,
  InboxSource,
} from "./types.ts";

/**
 * What an agent without `sandboxes` has: none, so `sandboxes.anything` and
 * `sandboxTools.anything` fail to compile.
 */
type NoSandboxes = Record<never, never>;

export interface Agents<TClient extends Inngest.Any = Inngest.Any> {
  /**
   * Defines an agent: a function whose body owns its loop and reads a
   * durable inbox.
   * @param config Function ID and KV store.
   * @param body Your loop; optional. Without one the run ends with output `undefined`.
   */
  agent<
    TType extends EventTypeWithAnySchema<string>,
    TOutput = unknown,
    TSandboxes extends SandboxToolNames = NoSandboxes,
    const TMiddleware extends Middleware.Class[] | undefined = undefined,
    const TInboxTools extends InboxToolsConfig | undefined = undefined,
    const TSources extends readonly InboxSource[] | undefined = undefined,
  >(
    config: AgentFunctionConfig<
      TType,
      {
        event: ThreadTriggerEventOf<TType>;
        sandboxes: TSandboxes;
        middleware: TMiddleware;
        inboxTools: TInboxTools;
        sources: TSources;
      }
    >,
    body?: (
      context: AgentBodyContext<{
        event: ThreadTriggerEventOf<TType>;
        sandboxes: TSandboxes;
        client: TClient;
        middleware: TMiddleware;
        inboxTools: TInboxTools;
        sources: TSources;
      }>,
    ) => Promise<TOutput>,
  ): AgentFunction<TOutput>;
  agent<
    const TTypes extends readonly EventTypeWithAnySchema<string>[],
    TOutput = unknown,
    TSandboxes extends SandboxToolNames = NoSandboxes,
    const TMiddleware extends Middleware.Class[] | undefined = undefined,
    const TInboxTools extends InboxToolsConfig | undefined = undefined,
    const TSources extends readonly InboxSource[] | undefined = undefined,
  >(
    config: AgentFunctionConfig<
      TTypes,
      {
        event: ThreadTriggerListEvent<TTypes>;
        sandboxes: TSandboxes;
        middleware: TMiddleware;
        inboxTools: TInboxTools;
        sources: TSources;
      }
    >,
    body?: (
      context: AgentBodyContext<{
        event: ThreadTriggerListEvent<TTypes>;
        sandboxes: TSandboxes;
        client: TClient;
        middleware: TMiddleware;
        inboxTools: TInboxTools;
        sources: TSources;
      }>,
    ) => Promise<TOutput>,
  ): AgentFunction<TOutput>;
  agent<
    const TOne extends ThreadTriggerEventSource,
    TOutput = unknown,
    TSandboxes extends SandboxToolNames = NoSandboxes,
    const TMiddleware extends Middleware.Class[] | undefined = undefined,
    const TInboxTools extends InboxToolsConfig | undefined = undefined,
    const TSources extends readonly InboxSource[] | undefined = undefined,
  >(
    config: AgentFunctionConfig<
      ThreadEventTrigger<TOne> | (TOne & EventTypeWithAnySchema<string>),
      {
        event: ThreadTriggerEventOf<TOne>;
        sandboxes: TSandboxes;
        middleware: TMiddleware;
        inboxTools: TInboxTools;
        sources: TSources;
      }
    >,
    body?: (
      context: AgentBodyContext<{
        event: ThreadTriggerEventOf<TOne>;
        sandboxes: TSandboxes;
        client: TClient;
        middleware: TMiddleware;
        inboxTools: TInboxTools;
        sources: TSources;
      }>,
    ) => Promise<TOutput>,
  ): AgentFunction<TOutput>;
  agent<
    TOutput = unknown,
    TSandboxes extends SandboxToolNames = NoSandboxes,
    const TMiddleware extends Middleware.Class[] | undefined = undefined,
    const TInboxTools extends InboxToolsConfig | undefined = undefined,
    const TSources extends readonly InboxSource[] | undefined = undefined,
  >(
    config: AgentFunctionConfig<
      ThreadCronTrigger,
      {
        event: ThreadCronEvent;
        sandboxes: TSandboxes;
        middleware: TMiddleware;
        inboxTools: TInboxTools;
        sources: TSources;
      }
    >,
    body?: (
      context: AgentBodyContext<{
        event: ThreadCronEvent;
        sandboxes: TSandboxes;
        client: TClient;
        middleware: TMiddleware;
        inboxTools: TInboxTools;
        sources: TSources;
      }>,
    ) => Promise<TOutput>,
  ): AgentFunction<TOutput>;
  agent<
    const TMany extends readonly unknown[],
    TOutput = unknown,
    TSandboxes extends SandboxToolNames = NoSandboxes,
    const TMiddleware extends Middleware.Class[] | undefined = undefined,
    const TInboxTools extends InboxToolsConfig | undefined = undefined,
    const TSources extends readonly InboxSource[] | undefined = undefined,
  >(
    config: AgentFunctionConfig<
      ThreadTriggerList<TMany>,
      {
        event: ThreadTriggerListEvent<TMany>;
        sandboxes: TSandboxes;
        middleware: TMiddleware;
        inboxTools: TInboxTools;
        sources: TSources;
      }
    >,
    body?: (
      context: AgentBodyContext<{
        event: ThreadTriggerListEvent<TMany>;
        sandboxes: TSandboxes;
        client: TClient;
        middleware: TMiddleware;
        inboxTools: TInboxTools;
        sources: TSources;
      }>,
    ) => Promise<TOutput>,
  ): AgentFunction<TOutput>;

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

  /**
   * Sends the `agents/registered` event with the cards of this client's
   * agents, so discovery in any app of the environment finds them. Call it
   * once the app is up (after `serve()` or `connect()`). A daily heartbeat
   * function in `functions()` sends it again, which keeps the cards inside
   * the event retention.
   */
  announce(): Promise<void>;
}

/**
 * The heartbeat function of each client: one, however many `createAgents()`
 * calls the client has.
 */
const announceFunctions = new WeakMap<object, InngestFunction.Any>();

/**
 * Options of `createAgents`.
 */
export interface CreateAgentsOptions {
  /**
   * Where the KV, thread state and indexes live: `redisKvAdapter(url)`,
   * `d1KvAdapter(env.DB)` or `memoryKvAdapter()`. Default: Redis at
   * `INNGEST_EXPERIMENTAL_KV_URL`. The guarantees of a store are on
   * `KvStore`. One store per app ID: a second `createAgents` for the same
   * client ID replaces the first's.
   */
  store?: KvStore;
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
 * @param options Where the agents keep their state.
 */
export const createAgents = <TClient extends Inngest.Any>(
  client: TClient,
  options: CreateAgentsOptions = {},
): Agents<TClient> => {
  if (options.store) {
    setAppKvStore(client.id, options.store);
  }

  const made: AgentFunction[] = [];

  return {
    // One implementation backs every overload of `Agents["agent"]`. The
    // overloads differ only in how they type `config` and `body`, which the
    // implementation takes as `any`, so the compiler cannot relate them; each
    // overload is checked at the call site, not here.
    agent: ((
      config: AgentFunctionConfig<unknown, any>,
      body?: AgentBody<any>,
    ) => {
      const created = createAgentFunction(
        client,
        config as AgentFunctionConfig,
        body,
      );

      made.push(created);
      rememberCard(client, created.card);

      if (!announceFunctions.has(client)) {
        announceFunctions.set(
          client,
          client.createFunction(
            {
              id: "agents-announce",
              triggers: [{ cron: "0 6 * * *" }, { event: agentsAnnounceEvent }],
            },
            async ({ step: announceStep }) => {
              await announceStep.sendEvent("announce", announcement(client));
            },
          ),
        );
      }

      return created;
    }) as unknown as Agents<TClient>["agent"],
    functions: () => {
      const functions = made.flatMap((created) => {
        return [created.fn, created.cleanup, created.finished];
      });
      const heartbeat = announceFunctions.get(client);

      return heartbeat && made.length > 0
        ? [...functions, heartbeat]
        : functions;
    },
    async announce() {
      await client.send(announcement(client));
    },
  };
};

export type {
  BatchOptions,
  Inbox,
  InboxMessage,
  ReadOptions,
} from "../../../components/inbox/Inbox.ts";
export type {
  AgentCard,
  AgentShare,
  AgentsRegisteredData,
  DiscoveryTools,
  DiscoveryToolsOptions,
} from "../discovery/discovery.ts";
export {
  addressOf,
  callAgent,
  discoveryTools,
  findAgents,
} from "../discovery/discovery.ts";
export type {
  AgentMessageData,
  AgentResendData,
  AgentRouting,
  AgentSteerData,
} from "../inbox/events.ts";
export {
  agentMessage,
  agentSteer,
} from "../inbox/events.ts";
export type {
  Kv,
  KvAdapter,
  KvIndex,
  KvIndexEntry,
  KvIndexRange,
  KvJson,
  KvJsonCheck,
  KvJsonSafe,
  KvKey,
  KvKeyInput,
  KvKeyOf,
  KvResult,
  KvRoundTrips,
  KvSchemaMustRoundTrip,
  KvScope,
  KvScopeInstance,
  KvSetOptions,
  KvSource,
  KvStore,
  KvValue,
  KvValueMustBeJson,
  KvWrite,
} from "../kv/kv.ts";
export {
  kv,
  kvKey,
  memoryKvAdapter,
  redisKvAdapter,
} from "../kv/kv.ts";
export type { D1KvDatabase, D1KvOptions, D1KvStatement } from "../kv/kvD1.ts";
export { d1KvAdapter, d1KvSchema } from "../kv/kvD1.ts";
export type { AgentScoreName, AgentScores } from "../loop/scores.ts";
export type {
  ThreadHandle,
  ThreadOptions,
  ThreadState,
  ThreadStatus,
  TriggerEvent,
} from "../threads/thread.ts";
export {
  agentMessageEvent,
  agentSteerEvent,
  getThread,
} from "../threads/thread.ts";
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
} from "../threads/threadTrigger.ts";
export type {
  AgentRecovery,
  LastRun,
  RunOutcome,
} from "./recovery.ts";
export type {
  AgentBody,
  AgentBodyContext,
  AgentBodyFields,
  AgentFunction,
  AgentFunctionConfig,
  AgentFunctionInput,
  AgentStartData,
  AgentTypeDefaults,
  AgentTypes,
  AgentTypesOf,
  InboxSource,
  OpenedInbox,
  ThreadInbox,
  ThreadInboxMessage,
} from "./types.ts";
