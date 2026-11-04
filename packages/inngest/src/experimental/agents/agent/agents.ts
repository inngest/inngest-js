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
import { callSite } from "../../../components/sandbox/callSite.ts";
import {
  hostSharedTool,
  type SharedTool,
} from "../../../components/sandbox/tools.ts";
import type { EventTypeWithAnySchema } from "../../../components/triggers/triggers.ts";
import { announceFunction, rememberCard } from "../discovery/discovery.ts";
import { type KvStore, setAppKvStore, usesLedger } from "../kv/kv.ts";
import type { AgentModel } from "../loop/loop.ts";
import type { SandboxToolNames } from "../sandboxes/defs.ts";
import { createLedgerFunctions } from "../threads/ledger.ts";
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
import { askTimeoutFunction } from "./askTimeout.ts";
import { agentFinishedFunction } from "./finishedRelay.ts";
import { parentEndedFunction } from "./lending.ts";
import { createSharedToolFunction } from "./sharedToolFunction.ts";
import type {
  AgentBody,
  AgentBodyContext,
  AgentFunction,
  AgentFunctionConfig,
  InboxSource,
  InboxSourceInput,
  ModelField,
  ModelFieldOf,
  StartInput,
} from "./types.ts";

/**
 * What an agent without `sandboxes` has: none, so `sandboxes.anything` fails
 * to compile.
 */
type NoSandboxes = Record<never, never>;

/**
 * The default output type of an agent defined without a body: it stands for
 * "no handler", so the output can follow the model.
 */
declare const noHandler: unique symbol;

interface NoHandler {
  readonly [noHandler]: true;
}

/**
 * What `result()` gives: the body's return type; without a body, the model's
 * final text for an agent with a `model` and `undefined` for one with neither.
 */
type OutputOf<TOutput, TModel extends ModelField | undefined> = [
  TOutput,
] extends [NoHandler]
  ? [TModel] extends [undefined]
    ? undefined
    : string
  : TOutput;

export interface Agents<TClient extends Inngest.Any = Inngest.Any> {
  /**
   * Defines an agent: a function whose body owns its loop and reads a
   * durable inbox.
   * @param config Function ID and KV store.
   * @param body Your loop; optional. Without one the run ends with output `undefined`.
   */
  agent<
    TType extends EventTypeWithAnySchema<string>,
    TOutput = NoHandler,
    TSandboxes extends SandboxToolNames = NoSandboxes,
    const TMiddleware extends Middleware.Class[] | undefined = undefined,
    const TSources extends readonly InboxSourceInput[] | undefined = undefined,
    TModel extends
      | ModelFieldOf<ThreadTriggerEventOf<TType>>
      | undefined = undefined,
  >(
    config: AgentFunctionConfig<
      TType,
      {
        event: ThreadTriggerEventOf<TType>;
        sandboxes: TSandboxes;
        middleware: TMiddleware;
        sources: TSources;
        model: TModel;
      }
    >,
    body?: (
      context: AgentBodyContext<{
        event: ThreadTriggerEventOf<TType>;
        sandboxes: TSandboxes;
        client: TClient;
        middleware: TMiddleware;
        sources: TSources;
        model: TModel;
      }>,
    ) => Promise<TOutput>,
  ): AgentFunction<
    OutputOf<TOutput, TModel>,
    StartInput<ThreadTriggerEventOf<TType>>
  >;
  agent<
    const TTypes extends readonly EventTypeWithAnySchema<string>[],
    TOutput = NoHandler,
    TSandboxes extends SandboxToolNames = NoSandboxes,
    const TMiddleware extends Middleware.Class[] | undefined = undefined,
    const TSources extends readonly InboxSourceInput[] | undefined = undefined,
    TModel extends
      | ModelFieldOf<ThreadTriggerListEvent<TTypes>>
      | undefined = undefined,
  >(
    config: AgentFunctionConfig<
      TTypes,
      {
        event: ThreadTriggerListEvent<TTypes>;
        sandboxes: TSandboxes;
        middleware: TMiddleware;
        sources: TSources;
        model: TModel;
      }
    >,
    body?: (
      context: AgentBodyContext<{
        event: ThreadTriggerListEvent<TTypes>;
        sandboxes: TSandboxes;
        client: TClient;
        middleware: TMiddleware;
        sources: TSources;
        model: TModel;
      }>,
    ) => Promise<TOutput>,
  ): AgentFunction<
    OutputOf<TOutput, TModel>,
    StartInput<ThreadTriggerListEvent<TTypes>>
  >;
  agent<
    const TOne extends ThreadTriggerEventSource,
    TOutput = NoHandler,
    TSandboxes extends SandboxToolNames = NoSandboxes,
    const TMiddleware extends Middleware.Class[] | undefined = undefined,
    const TSources extends readonly InboxSourceInput[] | undefined = undefined,
    TModel extends
      | ModelFieldOf<ThreadTriggerEventOf<TOne>>
      | undefined = undefined,
  >(
    config: AgentFunctionConfig<
      ThreadEventTrigger<TOne> | (TOne & EventTypeWithAnySchema<string>),
      {
        event: ThreadTriggerEventOf<TOne>;
        sandboxes: TSandboxes;
        middleware: TMiddleware;
        sources: TSources;
        model: TModel;
      }
    >,
    body?: (
      context: AgentBodyContext<{
        event: ThreadTriggerEventOf<TOne>;
        sandboxes: TSandboxes;
        client: TClient;
        middleware: TMiddleware;
        sources: TSources;
        model: TModel;
      }>,
    ) => Promise<TOutput>,
  ): AgentFunction<
    OutputOf<TOutput, TModel>,
    StartInput<ThreadTriggerEventOf<TOne>>
  >;
  agent<
    TOutput = NoHandler,
    TSandboxes extends SandboxToolNames = NoSandboxes,
    const TMiddleware extends Middleware.Class[] | undefined = undefined,
    const TSources extends readonly InboxSourceInput[] | undefined = undefined,
    TModel extends ModelFieldOf<ThreadCronEvent> | undefined = undefined,
  >(
    config: AgentFunctionConfig<
      ThreadCronTrigger,
      {
        event: ThreadCronEvent;
        sandboxes: TSandboxes;
        middleware: TMiddleware;
        sources: TSources;
        model: TModel;
      }
    >,
    body?: (
      context: AgentBodyContext<{
        event: ThreadCronEvent;
        sandboxes: TSandboxes;
        client: TClient;
        middleware: TMiddleware;
        sources: TSources;
        model: TModel;
      }>,
    ) => Promise<TOutput>,
  ): AgentFunction<OutputOf<TOutput, TModel>>;
  agent<
    const TMany extends readonly unknown[],
    TOutput = NoHandler,
    TSandboxes extends SandboxToolNames = NoSandboxes,
    const TMiddleware extends Middleware.Class[] | undefined = undefined,
    const TSources extends readonly InboxSourceInput[] | undefined = undefined,
    TModel extends
      | ModelFieldOf<ThreadTriggerListEvent<TMany>>
      | undefined = undefined,
  >(
    config: AgentFunctionConfig<
      ThreadTriggerList<TMany>,
      {
        event: ThreadTriggerListEvent<TMany>;
        sandboxes: TSandboxes;
        middleware: TMiddleware;
        sources: TSources;
        model: TModel;
      }
    >,
    body?: (
      context: AgentBodyContext<{
        event: ThreadTriggerListEvent<TMany>;
        sandboxes: TSandboxes;
        client: TClient;
        middleware: TMiddleware;
        sources: TSources;
        model: TModel;
      }>,
    ) => Promise<TOutput>,
  ): AgentFunction<
    OutputOf<TOutput, TModel>,
    StartInput<ThreadTriggerListEvent<TMany>>
  >;

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
 * The announce function of each client: one, however many `createAgents()`
 * calls the client has.
 */
const announceFunctions = new WeakMap<object, InngestFunction.Any>();

/**
 * The function that reports the end of runs `start_agent` began, one per
 * client.
 */
const finishedFunctions = new WeakMap<object, InngestFunction.Any>();

/**
 * The function that answers a model's unanswered question `timed_out`, one per
 * client.
 */
const askTimeoutFunctions = new WeakMap<object, InngestFunction.Any>();

/**
 * The thread ledger functions of each client, made once.
 */
const ledgers = new WeakMap<object, InngestFunction.Any[]>();

/**
 * Options of `createAgents`.
 */
export interface CreateAgentsOptions {
  /**
   * Where the KV, thread state, run records and indexes live:
   * `redisKvAdapter(url)`, `d1KvAdapter(env.DB)`, `memoryKvAdapter()` or
   * `ledgerKvAdapter()`. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL` when
   * that is set, else the ledger. The guarantees of a store are on `KvStore`.
   * One store per app ID: a second `createAgents` for the same client ID
   * replaces the first's.
   *
   * Optional. With no store everything (`kv.thread`, `kv.app`, `kv.env`,
   * `previousRun`, history, `budget`, `recovery` and a thread's sandboxes) is
   * kept by the ledger, functions that `agents.functions()` serves, with no
   * outside service. Its limits are on `ledgerKvAdapter`: 128 KB per scope
   * instance, no writes inside a step's callback, no reads from outside a
   * function, and `kv.env` shared by one app only. An operation it cannot do
   * throws an error that says to configure a store.
   */
  store?: KvStore;

  /**
   * EXPERIMENTAL: The shared tools (`tool.shared()`) this app hosts. Only
   * tools listed here are served: `agents.functions()` returns a function for
   * each, and the app announces their cards with its agents'. An app of
   * nothing but shared tools works.
   */
  tools?: readonly SharedTool[];
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
  const hosted = (options.tools ?? []).map((shared) => {
    const created = createSharedToolFunction(client, shared);

    hostSharedTool(shared, client.id);
    rememberCard(client.id, created.card);

    return created.fn;
  });

  if (hosted.length > 0 && !announceFunctions.has(client)) {
    announceFunctions.set(client, announceFunction(client));
  }

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
        callSite(),
      );

      made.push(created);
      rememberCard(client.id, created.card);

      if (!announceFunctions.has(client)) {
        announceFunctions.set(client, announceFunction(client));
      }

      if (!finishedFunctions.has(client)) {
        finishedFunctions.set(client, agentFinishedFunction(client));
        askTimeoutFunctions.set(client, askTimeoutFunction(client));
      }

      // Sent by a run that started attached children, once it ends for good.
      parentEndedFunction(client);

      return created;
    }) as unknown as Agents<TClient>["agent"],
    functions: () => {
      const functions = made.flatMap((created) => {
        return [created.fn, created.cleanup, created.finished];
      });
      const announcer = announceFunctions.get(client);
      const relay = finishedFunctions.get(client);
      const timeout = askTimeoutFunctions.get(client);

      const stored = !usesLedger(client.id);

      // With the ledger KV store each agent's finished function sends
      // `agent/finished`, so the relay that sends it is served only with
      // another store.
      const ledger = stored
        ? []
        : (ledgers.get(client) ??
          (ledgers.set(client, createLedgerFunctions(client)),
          ledgers.get(client) ?? []));

      if (made.length > 0 && announcer && relay && timeout) {
        return [
          ...hosted,
          ...functions,
          announcer,
          ...(stored ? [relay] : []),
          timeout,
          parentEndedFunction(client),
          ...ledger,
        ];
      }

      return announcer && hosted.length > 0
        ? [...hosted, ...functions, announcer]
        : [...hosted, ...functions];
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
  SharedTool,
  SharedToolContext,
  SharedToolDefinition,
} from "../../../components/sandbox/tools.ts";
export type {
  AgentCard,
  AgentCardConfig,
  AgentCardSkill,
  AgentDiscovery,
  AgentEffects,
  AgentShare,
  AgentSummary,
  AgentsRegisteredData,
  DiscoveryEntry,
  DiscoveryFilter,
  DiscoveryToolSet,
} from "../discovery/discovery.ts";
export { addressOf, matchesDiscovery } from "../discovery/discovery.ts";
export type {
  AgentAnswerData,
  AgentFinishedData,
  AgentGroupJoinedData,
  AgentMessageData,
  AgentQuestionData,
  AgentRecoverData,
  AgentRouting,
} from "../inbox/events.ts";
export {
  agentAnswer,
  agentFinished,
  agentGroupJoined,
  agentMessage,
  agentQuestion,
  agentRecover,
} from "../inbox/events.ts";
export type {
  AgentReportLine,
  AgentReportRoute,
} from "../inbox/reports.ts";
export type { Sender } from "../inbox/sender.ts";
export type {
  Kv,
  KvIndex,
  KvIndexEntry,
  KvIndexRange,
  KvKey,
  KvScope,
  KvScopeInstance,
  KvSetOptions,
  KvStore,
} from "../kv/kv.ts";
export {
  kv,
  memoryKvAdapter,
  redisKvAdapter,
} from "../kv/kv.ts";
export type { D1KvDatabase, D1KvOptions, D1KvStatement } from "../kv/kvD1.ts";
export { d1KvAdapter, d1KvSchema } from "../kv/kvD1.ts";
export type { AgentScoreName } from "../loop/scores.ts";
export type { LedgerKvStore } from "../threads/ledgerClient.ts";
export { ledgerKvAdapter } from "../threads/ledgerClient.ts";
export type {
  AskOptions,
  RunHandle,
  ThreadHandle,
  ThreadState,
  ThreadStatus,
  TriggerEvent,
} from "../threads/thread.ts";
export {
  agentMessageEvent,
  agentRecoverEvent,
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
export type { AgentToolSet } from "./agentTools.ts";
export type {
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
  AgentMessage,
  AgentTypeDefaults,
  AgentTypes,
  AgentTypesOf,
  InboxSource,
  InboxSourceInput,
  ModelField,
  OpenedInbox,
  StartInput,
} from "./types.ts";
