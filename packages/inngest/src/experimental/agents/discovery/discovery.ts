/**
 * @module
 * EXPERIMENTAL: agent discovery. Every agent has a card that says what it does
 * and what it accepts. An app announces its cards in `agents/registered`
 * events when the app syncs with Inngest and, as a fallback, from a cron
 * function every 6 hours, and `list_agents` and
 * `describe_agent` read the newest card of each agent of the last 24 hours
 * back, so agents find each other across apps of one environment without
 * naming each other in code. The agents of the caller's own app are found at
 * once, from their definitions.
 */

import { z } from "zod/v4";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import {
  type Inngest,
  internalLoggerSymbol,
  syncHooksSymbol,
} from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { step } from "../../../components/InngestStepTools.ts";
import type { SourceLocation } from "../../../components/sandbox/callSite.ts";
import {
  type ToolDescriptionParts,
  toolDescriptionText,
} from "../../../components/sandbox/toolDescription.ts";
import {
  type AgentTool,
  toJsonSchema,
  tool,
  triggerSchema,
} from "../../../components/sandbox/tools.ts";
import type { Context } from "../../../types.ts";
import { limitStateOf } from "../agent/limits.ts";
import { cardsAreSigned, signCards } from "../agent/relations.ts";
import type { Json, JsonSchema } from "../json.ts";
import type { AgentCardTool } from "./cardTools.ts";
import { type AppFunctions, readAppFunctions } from "./functions.ts";
import {
  type DiscoveryEntry,
  defaultDiscovery,
  matchesDiscovery,
} from "./match.ts";

export type { SourceLocation } from "../../../components/sandbox/callSite.ts";
export type { AgentCardTool } from "./cardTools.ts";
export type {
  DiscoveryEntry,
  DiscoveryFilter,
  NormalizedDiscoveryEntry,
} from "./match.ts";
export {
  defaultDiscovery,
  matchesDiscovery,
  normalizeDiscoveryList,
  validateDiscoveryList,
} from "./match.ts";

/**
 * The name of the event an app sends with its cards.
 */
export const agentsRegisteredEvent = "agents/registered";

/**
 * When an app announces its cards regardless of change: every 6 hours, so a
 * card stays inside the 24-hour window discovery reads. This is the fallback;
 * an app also announces whenever it syncs with Inngest (`announceIfChanged`).
 */
export const announceCron = "0 */6 * * *";

/**
 * Who may find an agent. `"private"`: only agents of its own app. `"team"`:
 * any agent in the environment. Discovery is not access control: code that
 * imports an agent or builds a reference to it does not read cards.
 *
 * Not a field of the published `AgentCard`: it is an input to computing a
 * caller's roster (see `AnnouncedCard`), not something the card itself says.
 */
export type AgentShare = "private" | "team";

/**
 * What a call to an agent does to the world: `"read"` looks things up or
 * computes an answer and changes nothing outside its own thread; `"write"`
 * can send, post, charge or otherwise change the world; `"destructive"`
 * deletes or otherwise does something a write cannot undo. Default
 * `"write"` when a card does not say.
 *
 * Corresponds to MCP's tool hints: `"read"` is `readOnlyHint: true`,
 * `"destructive"` is `destructiveHint: true`. The names are not renamed to
 * match MCP's so that a future integration with MCP tool hints is a mapping
 * between the two vocabularies, not a redesign of this one.
 */
export type AgentEffects = "read" | "write" | "destructive";

/**
 * A skill of an agent, as its card lists it.
 */
export interface AgentCardSkill {
  name: string;
  description: string;
}

/**
 * What an agent publishes about itself: public, static, and identical for
 * every reader. A card says what an agent *is*; it carries only identity and
 * capability, never a policy about who may see it. Who may see what is a
 * roster, computed per caller from the card plus the definition's `share`
 * and `explicit` (see `AnnouncedCard`) — not a field of the card itself.
 */
export interface AgentCard {
  /**
   * What the card describes. `"tool"` for a shared tool made with
   * `tool.shared()`, which discovery offers as a tool and never as an agent.
   * Absent for an agent.
   */
  kind?: "tool";

  /**
   * `"<app>/<agent>"`. It maps onto `referenceFunction({ appId, functionId })`;
   * the platform's qualified ID is `"<app>-<agent>"`.
   */
  address: string;

  /**
   * What the agent does: its `card.description`, else the function's
   * `description` option.
   */
  description?: string;

  /**
   * JSON Schema of the input of the agent's `invoke()` trigger. An agent
   * without one has no `input`.
   */
  input?: JsonSchema;

  /**
   * The agent's skills: each `SKILL.md`'s name and description.
   */
  skills?: AgentCardSkill[];

  /**
   * Prose labels of the problem domains the agent handles, such as
   * `"pipeline failures"` or `"deployment readiness"` — when to pick this
   * agent, not what tools it has. Always present on a published card: given
   * in `card.capabilities`, or derived from `card.tags` when absent (logged
   * as a warning at definition time, since a derived list is worse than an
   * authored one).
   */
  capabilities: string[];

  /**
   * Authorization labels from the card, such as `"sdk"` or `"billing"`. Used
   * only by the policy filter (`discovery.agents`' `{ tags }`); nothing
   * matches a free-text query against them. Routing — finding the right
   * agent for a job — reads `capabilities` and `description` instead, so a
   * tag added for findability never silently widens who may reach the agent.
   */
  tags?: string[];

  /**
   * EXPERIMENTAL: where the agent was defined (the call to `agents.agent()`),
   * for tools such as "open in VS Code". Only published in dev mode, and
   * absent when the location could not be read. Not in `list_agents`.
   */
  source?: SourceLocation;

  /**
   * EXPERIMENTAL: the agent's tools by the names its model sees (`getOrg`,
   * `lab_run`), with their descriptions, and in dev mode where each was
   * defined. Lists the tools written in the definition: a `tools` or
   * `sandboxes` that is a function of the run, and the tools of an MCP
   * server, are not listed. Not in `list_agents`; `describe_agent` has it.
   */
  tools?: AgentCardTool[];

  /**
   * How to work with the agent once you've picked it: what to give it, how
   * it expects to be asked. Free prose, optional. Appears only in the full
   * card from `describe_agent`, not in the roster `list_agents` returns —
   * by the time you're reading it you've already chosen this agent.
   */
  instructions?: string;

  /**
   * The team or person who owns the agent.
   */
  owner?: string;

  /**
   * What a call does. `"write"` unless the card says otherwise.
   */
  effects: AgentEffects;

  /**
   * How long a call takes.
   */
  speed?: "seconds" | "minutes";

  /**
   * Set when a card is read, never announced: the agent's function is paused
   * or archived.
   */
  paused?: boolean;
}

/**
 * A card together with the definition's roster inputs: `share` and
 * `explicit` from `AgentCardConfig`. These decide who may see the card and
 * through what kind of discovery entry, but they are not part of the card
 * itself — the card is identical for every reader; the roster computed from
 * it is not. This is the shape kept in bookkeeping (`cardsOf`, `currentCards`,
 * `agents/registered`'s `cards`) and consumed by `mayUse`/`matchesDiscovery`;
 * `describe_agent` and `list_agents` strip `share`/`explicit` back off before
 * answering, since a reader is never shown why it was let through.
 */
export interface AnnouncedCard extends AgentCard {
  /**
   * Who may find the agent. `"private"` unless the definition says `"team"`.
   */
  share: AgentShare;

  /**
   * Set when the definition says `explicit: true`. Filter entries in
   * `discovery.agents` never match the card; only an imported agent or its
   * exact address does.
   */
  explicit?: boolean;
}

/**
 * The public card inside an `AnnouncedCard`, with the roster inputs
 * (`share`, `explicit`) removed: what a reader may actually be shown.
 */
export const publicCardOf = (announced: AnnouncedCard): AgentCard => {
  const { share: _share, explicit: _explicit, ...card } = announced;

  return card;
};

/**
 * EXPERIMENTAL: What a card's `description` takes: a string, used as it is, or
 * the parts a tool's description has (`does`, `use`, `avoid`), which render
 * into one paragraph the same way: "Does X. Use it when Y. Don't use it when
 * Z." A model choosing an agent in `list_agents` reads that paragraph. There
 * is no `returns`: what an agent gives back is described by its typed reports
 * and schemas.
 *
 * @example
 * ```ts
 * card: {
 *   description: {
 *     does: "Answers questions about the docs.",
 *     use: "when the question is about how a product works",
 *     avoid: "for account or billing questions",
 *   },
 * }
 * ```
 * reads as "Answers questions about the docs. Use it when the question is
 * about how a product works. Don't use it for account or billing questions."
 */
export type AgentCardDescription =
  | string
  | Pick<ToolDescriptionParts, "does" | "use" | "avoid">;

/**
 * The `card` field of an agent's definition: what the agent publishes about
 * itself so other agents can find it, and who may.
 *
 * @example
 * ```ts
 * card: {
 *   description: {
 *     does: "Answers questions about the docs.",
 *     use: "when the question is about how a product works",
 *     avoid: "for account or billing questions",
 *   },
 *   capabilities: ["docs questions"],
 *   tags: ["docs", "research"],
 *   share: "team",
 *   effects: "read",
 * }
 * ```
 */
export interface AgentCardConfig {
  /**
   * What the agent does: a string, or `{ does, use?, avoid? }` (see
   * `AgentCardDescription`). The card stores and announces the rendered
   * string. Without it the card uses the function's own `description` option.
   *
   * A model choosing between agents reads this and little else, so write it
   * for that choice. `does` says what the agent produces. `use` names the
   * work it suits, as a clause that finishes "Use it ...". `avoid` names the
   * tempting wrong job, as a clause that finishes "Don't use it ...". These
   * follow the clause rules of a tool's `description`. The common mistake is
   * a vague `does` ("Helps with docs") and no `avoid`, so a model sends the
   * wrong work to the agent.
   */
  description?: AgentCardDescription;

  /**
   * Short prose labels of the problem domains the agent handles — when to
   * pick it, not what tools it has: `["pipeline failures", "deployment
   * readiness"]`, not `["run_tests", "deploy"]` (those are tool names, not
   * capabilities). This is what a model matches against when choosing an
   * agent in `list_agents`, alongside `description`.
   *
   * Optional here; always present on the published card. Without it, the
   * card derives `capabilities` from `tags` and a warning is logged at
   * definition time naming the agent, since a derived capability list is
   * worse than an authored one — write this yourself when you can.
   */
  capabilities?: string[];

  /**
   * Authorization labels, in lower-case words agreed across the agents of
   * the environment: `["research"]`, `["billing", "refunds"]`. Used only by
   * the policy filter: a `{ tags }` entry in `discovery.agents` needs the
   * card to have every tag it lists, exactly as spelled. Not used to find
   * the agent — `list_agents` never matches a query against tags, and
   * routing reads `capabilities`/`description` instead — so a tag added here
   * for authorization never doubles as something that makes the agent easier
   * to stumble onto. Spell tags the same way on every agent that shares a
   * role: `"research"` on one and `"researcher"` on another will not match
   * one filter.
   */
  tags?: string[];

  /**
   * EXPERIMENTAL: when `true`, broad `discovery` filters (objects such as
   * `{ app: "platform" }`) never match this agent. Only an agent that imports
   * it, or names its exact address, can find or start it. Default `false`.
   *
   * Use it for agents that should only be reached on purpose: those that act
   * on money, production systems or people's data. It hides the agent from
   * `list_agents` for everyone else; to reach it anyway, import the agent into
   * the caller's `discovery.agents` or list its `"app/name"` address there.
   * `share` limits which apps may find the agent; `explicit` limits which
   * kinds of entry may. Use both for the most sensitive agents.
   */
  explicit?: boolean;

  /**
   * Who may find the agent. Default `"private"`: only agents of its own app.
   * Choose `"team"` for an agent that other apps in the environment should be
   * able to use, and then keep it narrow with `effects` and `explicit`. A
   * `"private"` agent is invisible to other apps even when they name its
   * address. This is not access control: code that imports the agent and
   * calls `agent.start()` is not filtered.
   */
  share?: AgentShare;

  /**
   * How to work with the agent once picked: what to give it, how it expects
   * to be asked, such as `"Give me a repo and a time range."`. Free prose,
   * optional. Published in the full card `describe_agent` returns; left out
   * of the roster `list_agents` returns, since it only matters once you've
   * already chosen the agent.
   */
  instructions?: string;

  /**
   * The team or person who owns the agent, such as `"payments"`. Other agents
   * can filter on it with `{ owner }` in `discovery.agents`, and a person
   * reading the card knows whom to ask.
   */
  owner?: string;

  /**
   * What a call does: `"read"`, `"write"` or `"destructive"`. Default
   * `"write"`.
   *
   * Choose `"read"` when a call only looks things up or computes an answer
   * and changes nothing outside its own thread. Choose `"write"` when it can
   * send, post, charge or otherwise change the world, but not in a way that
   * is hard to undo — opening a pull request, say. Choose `"destructive"`
   * when it can do something that is hard or impossible to undo — deleting a
   * saved action, dropping data. The default is the safe one: by default
   * `discovery` shows an agent only the read agents of other apps
   * (`[{ app: "self" }, { effects: "read" }]`), so an agent you leave at
   * `"write"` is not found by other apps until they list it, and a
   * `{ effects: "write" }` filter never matches a `"destructive"` card (an
   * exact match, not a ceiling: asking for `"write"` does not also accept
   * worse). Marking an agent `"read"` that writes, or `"write"` that
   * destroys, is the mistake to avoid; it makes it discoverable, or reachable
   * through a filter, that was never meant to reach it.
   */
  effects?: AgentEffects;

  /**
   * How long a call takes: `"seconds"` or `"minutes"`. It is published on the
   * card for whoever reads it and changes nothing else. Say `"minutes"` for an
   * agent that works through many steps or waits on people, and leave it out
   * when the time varies too much to promise.
   */
  speed?: "seconds" | "minutes";
}

/**
 * EXPERIMENTAL: the `discovery` field of an agent's definition. Discovery is
 * opt-in: with no `discovery` (or `false`) the model gets no `list_agents`,
 * `describe_agent` or `start_agent`, and no shared tools from other apps
 * (the agent's own card is still published). `true` turns them on with the
 * defaults, as do the options: `{ prepare }` fills part of the input of a
 * call to another agent from the host, and `agents` and `tools` filter what
 * the model can see and may start.
 */
export type AgentDiscovery = boolean | AgentDiscoveryOptions;

/**
 * EXPERIMENTAL: the options of `discovery`.
 */
export type AgentDiscoveryOptions = {
  /**
   * Runs in the run, before a call to another agent: gets the card, the
   * input the model gave, the run's trigger event and its thread. Returns
   * the input to use.
   */
  prepare?: (call: {
    card: AgentCard;
    input: Record<string, Json>;
    event: Context.Any["event"];
    thread: { key: string };
  }) => Record<string, Json> | Promise<Record<string, Json>>;

  /**
   * EXPERIMENTAL: the agents the model can see (`list_agents`,
   * `describe_agent`) and may start (`start_agent`). Any entry may match;
   * the fields of one filter object must all match. Default: the agent's
   * own app plus read-only agents of other apps,
   * `[{ app: "self" }, { effects: "read" }]` (still subject to `share`).
   * A started agent never sees more than its starter allowed. Code that
   * calls `agent.start()` directly is not filtered.
   *
   * Narrow beats broad: list only what the agent has a reason to start. A
   * long list costs the model attention and widens what a mistaken or
   * manipulated call can reach. Filter by the roles you tagged
   * (`{ tags: ["research"] }`), pin the few agents you know
   * (an imported agent, or `"platform/triage"`), and leave out `explicit`
   * agents unless you name them. An empty list matches nothing.
   *
   * @example
   * ```ts
   * discovery: {
   *   // Any read-only agent tagged "research", in any app, and one exact agent.
   *   agents: [
   *     { tags: ["research"], effects: "read" },
   *     "platform/triage",
   *   ],
   * }
   * ```
   */
  agents?: DiscoveryEntry[];

  /**
   * EXPERIMENTAL: the same filter for shared tools (`tool.shared()`), which
   * the model then calls like its own tools. Same default, and the same
   * advice: name the few shared tools the agent needs, by address or by tag,
   * as in `[{ tags: ["social"] }]` or `["acme/post-to-x"]`.
   */
  tools?: DiscoveryEntry[];
};

/**
 * The options of a `discovery` field that turns discovery on (`true` is the
 * defaults), or `undefined` when it is off (left out, or `false`).
 */
export const discoveryOptionsOf = (
  discovery: AgentDiscovery | undefined,
): AgentDiscoveryOptions | undefined => {
  if (discovery === undefined || discovery === false) {
    return undefined;
  }

  return discovery === true ? {} : discovery;
};

/**
 * What `list_agents` returns for each agent: the roster entry. Carries
 * `capabilities` (the routing signal) instead of `tags` (the authorization
 * label, which nothing uses for finding), and never `instructions` (the full
 * card from `describe_agent` has that).
 */
export type AgentSummary = Pick<
  AgentCard,
  "address" | "description" | "capabilities" | "skills" | "effects" | "paused"
>;

/**
 * The data of `agents/registered`.
 */
export interface AgentsRegisteredData {
  /**
   * The app that announced.
   */
  app: string;

  /**
   * The cards of the app's agents, with the roster inputs (`share`,
   * `explicit`) that decide who may see each one.
   */
  cards: AnnouncedCard[];

  /**
   * An HMAC with the environment's signing key over the app ID and the
   * cards. An announcement without a signature that matches is ignored by
   * readers, so a sender that only holds an event key cannot publish cards.
   */
  sig?: string;
}

/**
 * The cards of each app's own agents, by app ID then agent ID: what the
 * running process defines.
 */
const ownCardsByApp = new Map<string, Map<string, AnnouncedCard>>();

/**
 * The cards of the agents `appId` defines in this process.
 */
export const cardsOf = (appId: string): AnnouncedCard[] => {
  return [...(ownCardsByApp.get(appId)?.values() ?? [])];
};

/**
 * Remembers the card of an agent of `appId`, for the announce function and for
 * finding same-app agents at once.
 */
export const rememberCard = (appId: string, card: AnnouncedCard): void => {
  const cards = ownCardsByApp.get(appId) ?? new Map<string, AnnouncedCard>();

  cards.set(card.address, card);
  ownCardsByApp.set(appId, cards);
};

/**
 * The app of an address, `"<app>/<agent>"`.
 */
const appOf = (address: string): string => {
  return address.slice(0, address.indexOf("/"));
};

/**
 * The agent of an address, `"<app>/<agent>"`.
 */
const agentOf = (address: string): string => {
  return address.slice(address.indexOf("/") + 1);
};

/**
 * Makes the card of an agent.
 */
export const cardOf = (
  /**
   * The client that serves the agent.
   */
  app: string,

  /**
   * The agent's function ID.
   */
  agentId: string,

  /**
   * The agent's function, which says what it accepts.
   */
  fn: InngestFunction.Any,

  /**
   * What the card is made from.
   */
  parts: {
    /**
     * The definition's `card` field.
     */
    card?: AgentCardConfig;

    /**
     * The function's own `description` option, for a card without one.
     */
    description?: string;

    /**
     * The agent's skills.
     */
    skills?: AgentCardSkill[];

    /**
     * `"tool"` for the card of a shared tool.
     */
    kind?: "tool";

    /**
     * Where the agent or shared tool was defined.
     */
    source?: SourceLocation;

    /**
     * The agent's tools.
     */
    tools?: AgentCardTool[];

    /**
     * Where to log a warning when `capabilities` is derived from `tags`.
     * Absent for a shared tool's card, which has no `capabilities`.
     */
    logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
  },
): AnnouncedCard => {
  const schema = triggerSchema(fn, true);
  let input: JsonSchema | undefined;

  if (schema) {
    try {
      input = toJsonSchema(agentId, schema) as JsonSchema;
    } catch {
      // A schema that cannot become JSON Schema (zod 3, say) still means the
      // agent takes typed input, so the card must still say it has an input.
      input = { type: "object" };
    }
  }

  const config = parts.card ?? {};
  const given = config.description;
  const description =
    given === undefined
      ? parts.description
      : typeof given === "string"
        ? given
        : toolDescriptionText({
            does: given.does,
            use: given.use,
            avoid: given.avoid,
          });

  let capabilities = config.capabilities;

  if ((!capabilities || capabilities.length === 0) && parts.kind !== "tool") {
    capabilities = config.tags ?? [];
    parts.logger?.warn(
      { agent: `${app}/${agentId}` },
      capabilities.length > 0
        ? `Agent "${app}/${agentId}" has no card.capabilities, so they were derived from card.tags. Write capabilities yourself: a derived list is worse than an authored one.`
        : `Agent "${app}/${agentId}" has no card.capabilities and no card.tags to derive them from, so its card.capabilities is empty. A model cannot find this agent by what it does; write capabilities.`,
    );
  }

  return {
    ...(parts.kind === "tool" && { kind: "tool" as const }),
    address: `${app}/${agentId}`,
    ...(description !== undefined && { description }),
    ...(input && { input }),
    ...(parts.skills && parts.skills.length > 0 && { skills: parts.skills }),
    capabilities: capabilities ?? [],
    ...(config.tags && config.tags.length > 0 && { tags: config.tags }),
    ...(parts.source && { source: parts.source }),
    ...(parts.tools && parts.tools.length > 0 && { tools: parts.tools }),
    ...(config.instructions !== undefined && {
      instructions: config.instructions,
    }),
    ...(config.explicit === true && { explicit: true }),
    share: config.share ?? "private",
    ...(config.owner !== undefined && { owner: config.owner }),
    effects: config.effects ?? "write",
    ...(config.speed && { speed: config.speed }),
  };
};

/**
 * A card as it is published: `source` of the agent and of its tools only in
 * dev mode.
 */
export const publishedCard = (
  client: Inngest.Any,
  card: AnnouncedCard,
): AnnouncedCard => {
  if (client.mode === "dev" || (!card.source && !card.tools)) {
    return card;
  }

  const { source: _source, tools, ...rest } = card;

  return {
    ...rest,
    ...(tools && {
      tools: tools.map(({ source: _toolSource, ...tool }) => {
        return tool;
      }),
    }),
  };
};

/**
 * The event of an app's announcement: its own agents' cards.
 */
export const announcement = (
  client: Inngest.Any,
): { name: string; data: AgentsRegisteredData } => {
  const cards = cardsOf(client.id).map((card) => {
    return publishedCard(client, card);
  });

  return {
    name: agentsRegisteredEvent,
    data: { app: client.id, cards, sig: signCards(client, cards) },
  };
};

/**
 * The signature of the cards each client last announced in this process. The
 * signature is an HMAC over the cards, so it changes exactly when the cards do.
 */
const lastAnnounced = new WeakMap<object, string>();

/**
 * Announces the app's cards, and remembers what it sent.
 */
const announce = async (
  client: Inngest.Any,
  send: (event: ReturnType<typeof announcement>) => Promise<unknown>,
): Promise<void> => {
  const event = announcement(client);

  await send(event);
  lastAnnounced.set(client, event.data.sig ?? "");
};

/**
 * EXPERIMENTAL: Announces the app's cards unless the same cards were the last
 * thing this process announced. Runs whenever the app is synced with Inngest,
 * so a newly deployed or reloaded app's agents are discoverable at once. The
 * Dev Server syncs often, so the content check keeps it to one event per
 * change. The cron announces regardless, to keep cards inside the window
 * discovery reads.
 *
 * Never throws: an app without an event key, or a Dev Server that is not up,
 * leaves the cron to announce.
 * @param client The app's client.
 */
export const announceIfChanged = async (
  client: Inngest.Any,
): Promise<"sent" | "unchanged" | "failed"> => {
  const { data } = announcement(client);

  if (data.cards.length === 0 || lastAnnounced.get(client) === data.sig) {
    return "unchanged";
  }

  try {
    await announce(client, async (event) => {
      return client.send(event);
    });

    return "sent";
  } catch (err) {
    client[internalLoggerSymbol].debug(
      { err },
      "Could not announce agent cards after sync; the cron will",
    );

    return "failed";
  }
};

const syncHooked = new WeakSet<object>();

/**
 * Makes the app announce its cards (see `announceIfChanged`) each time it is
 * synced with Inngest. Once per client.
 */
export const announceOnSync = (client: Inngest.Any): void => {
  if (syncHooked.has(client)) {
    return;
  }

  syncHooked.add(client);
  client[syncHooksSymbol].add(async () => {
    await announceIfChanged(client);
  });
};

/**
 * The function that announces an app's cards every 6 hours, as a fallback for
 * the announcement on sync. On the Dev Server it can be invoked by hand.
 */
export const announceFunction = (client: Inngest.Any): InngestFunction.Any => {
  return client.createFunction(
    { id: "agents-announce", triggers: [{ cron: announceCron }] },
    async ({ step: announceStep }) => {
      await announce(client, async (event) => {
        return announceStep.sendEvent("announce", event);
      });
    },
  );
};

const windowMs = 24 * 60 * 60 * 1000;
const insightsRows = 1000;
const pageSize = 50;
const maxPages = 20;

/**
 * The most cards one announcement is read for, and the most distinct agents
 * one app can have in a read. A signed announcement can still be large, and a
 * read must stay bounded whoever sent it.
 */
const maxCardsPerAnnouncement = 200;
const maxCardsPerApp = 500;

/**
 * The cards in `agents/registered` data, each kept only when its address names
 * the app that announced it, and only when the announcement is signed over its
 * app and cards with the environment's signing key. Unsigned or altered ones
 * give nothing.
 */
const ownCardsOf = (client: Inngest.Any, data: unknown): AnnouncedCard[] => {
  const announced = data as Partial<AgentsRegisteredData> | undefined;

  if (
    typeof announced?.app !== "string" ||
    announced.app === "" ||
    !Array.isArray(announced.cards) ||
    !cardsAreSigned(client, announced.app, announced.cards, announced.sig)
  ) {
    return [];
  }

  const app = announced.app;

  return announced.cards.slice(0, maxCardsPerAnnouncement).filter((card) => {
    return (
      typeof card?.address === "string" &&
      card.address.includes("/") &&
      appOf(card.address) === app &&
      agentOf(card.address).length > 0
    );
  });
};

/**
 * Keeps the newest card of each agent of one announcement, up to a cap per
 * app, so the first (newest) announcements win and an app cannot take over the
 * list.
 */
const keepCards = (
  client: Inngest.Any,
  latest: Map<string, AnnouncedCard>,
  perApp: Map<string, number>,
  data: unknown,
): void => {
  for (const card of ownCardsOf(client, data)) {
    if (latest.has(card.address)) {
      continue;
    }

    const app = appOf(card.address);
    const count = perApp.get(app) ?? 0;

    if (count >= maxCardsPerApp) {
      continue;
    }

    perApp.set(app, count + 1);
    latest.set(card.address, card);
  }
};

const is501 = (error: unknown): boolean => {
  return error instanceof Error && /\b501\b/.test(error.message);
};

/**
 * Reads the newest card of each agent announced in the last 24 hours, not the
 * newest announcement of each app: a later announcement that lists fewer
 * agents does not hide the others. Cloud answers an Insights query; the Dev
 * Server answers 501 to it, so the read falls back to listing the events.
 * Only announcements signed with the environment's signing key are read. A
 * failed read throws; it never gives an empty list. A flood of announcements
 * cannot make it throw: it reads the newest 1000 and caps the cards per app.
 */
export const readCards = async (
  client: Inngest.Any,
): Promise<AnnouncedCard[]> => {
  const latest = new Map<string, AnnouncedCard>();
  const perApp = new Map<string, number>();
  const cutoff = Date.now() - windowMs;

  try {
    const result = await client.queryInsights(
      `SELECT data FROM events WHERE name = '${agentsRegisteredEvent}' AND ts > ${cutoff} ORDER BY ts DESC LIMIT ${insightsRows}`,
    );

    // Anyone with the event key can send announcements, signed or not, so a
    // full page is no reason to fail the read for every caller: the newest
    // rows are read and the rest are left, with a warning.
    if (result.rows.length >= insightsRows) {
      client[internalLoggerSymbol]?.warn(
        `Discovery found ${insightsRows} announcements in the last 24 hours, which is the most one read can see, so some agents may be missing.`,
      );
    }

    const column = Math.max(result.columns.indexOf("data"), 0);

    for (const row of result.rows) {
      const raw = row[column];
      let data: unknown;

      try {
        data = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
      } catch {
        // One malformed row must not fail the read for everyone.
        continue;
      }

      keepCards(client, latest, perApp, data);
    }

    return [...latest.values()];
  } catch (error) {
    if (!is501(error)) {
      throw error;
    }
  }

  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const events = await client.listEvents({
      name: agentsRegisteredEvent,
      limit: pageSize,
      cursor,
    });
    let reachedEnd = events.length < pageSize;

    for (const event of events) {
      if (event.ts !== undefined && event.ts < cutoff) {
        reachedEnd = true;
        break;
      }

      keepCards(client, latest, perApp, event.data);
    }

    if (reachedEnd) {
      break;
    }

    cursor = events[events.length - 1]?.internalId;
  }

  return [...latest.values()];
};

/**
 * Where discovery reads the status of the functions of an app. A test seam;
 * the default reads the platform.
 */
export type ReadFunctions = (app: string) => Promise<AppFunctions>;

/**
 * The current cards: the caller's own agents from their definitions, merged
 * with the newest announced cards of other apps. A card of another app whose
 * function is paused or archived is marked `paused`; one whose function is not
 * in the app's function list is dropped.
 */
export const currentCards = async (
  client: Inngest.Any,
  options: { functions?: ReadFunctions } = {},
): Promise<AnnouncedCard[]> => {
  const announced = (await readCards(client)).filter((card) => {
    return appOf(card.address) !== client.id;
  });
  const apps = [
    ...new Set(
      announced.map((card) => {
        return appOf(card.address);
      }),
    ),
  ];
  const read = options.functions ?? ((app) => readAppFunctions(client, app));
  const functions = new Map(
    await Promise.all(
      apps.map(async (app) => {
        return [app, await read(app)] as const;
      }),
    ),
  );
  const others = announced.flatMap((card) => {
    const status = functions
      .get(appOf(card.address))
      ?.get(agentOf(card.address));

    if (!status) {
      return [];
    }

    return [
      status.paused || status.archived ? { ...card, paused: true } : card,
    ];
  });

  return [
    ...cardsOf(client.id).map((card) => {
      return publishedCard(client, card);
    }),
    ...others,
  ];
};

/**
 * Whether `caller` may find the agent of `card`.
 */
export const mayUse = (
  card: Pick<AnnouncedCard, "address" | "share">,
  caller: string,
): boolean => {
  return card.share === "team" || appOf(card.address) === caller;
};

/**
 * The address of a card: what the tools take as `address`.
 */
export const addressOf = (card: Pick<AgentCard, "address">): string => {
  return card.address;
};

/**
 * What a card shows in `list_agents`: the roster entry, not the whole card.
 */
export const summaryOf = (card: AnnouncedCard): AgentSummary => {
  return {
    address: card.address,
    ...(card.description !== undefined && { description: card.description }),
    ...(card.skills && { skills: card.skills }),
    capabilities: card.capabilities,
    effects: card.effects,
    ...(card.paused && { paused: true }),
  };
};

const callerOf = (): { client: Inngest.Any; appId: string } => {
  const client = getAsyncCtxSync()?.app as unknown as Inngest.Any | undefined;

  if (!client) {
    throw new Error(
      "The discovery tools must be called inside an Inngest function",
    );
  }

  return { client, appId: client.id };
};

/**
 * How long a read of the agents' cards is reused within a run.
 */
export const cardsFreshMs = 30_000;

/**
 * What a run has read so far: the cards, and when they were read. Keyed by
 * the run's execution, so a replay starts fresh and finds each read memoized
 * as a step.
 */
const readsByRun = new WeakMap<
  object,
  { cards?: Promise<{ at: number; cards: AnnouncedCard[] }>; reads: number }
>();

/**
 * Options of the discovery tools.
 */
export interface DiscoveryToolSetOptions {
  /**
   * The definition's `discovery` field: its `agents` filter decides what the
   * tools show and start.
   */
  discovery?: AgentDiscovery;

  /**
   * Reads the functions of an app. For tests; defaults to the platform.
   */
  functions?: ReadFunctions;
}

/**
 * The current cards. Each call is a step: inside it, a read less than
 * `cardsFreshMs` old is reused (the step says so and stores nothing), and an
 * older one is read again. The clock is read inside the step, so a replay
 * takes the same path. Agents added or removed while a run is live show up
 * within 30 seconds.
 */
export const discoverCards = async (
  options: DiscoveryToolSetOptions = {},
): Promise<AnnouncedCard[]> => {
  const { client } = callerOf();
  const key = getAsyncCtxSync()?.execution ?? client;
  const state = readsByRun.get(key) ?? { reads: 0 };

  readsByRun.set(key, state);

  const before = state.cards;
  const id = `discover:cards:${state.reads++}`;

  state.cards = (async () => {
    const previous = await before?.catch(() => undefined);
    const read = (await step.run(id, async () => {
      if (previous && Date.now() - previous.at < cardsFreshMs) {
        return { reused: true };
      }

      return {
        at: Date.now(),
        cards: await currentCards(client, { functions: options.functions }),
      };
    })) as { reused: true } | { at: number; cards: AnnouncedCard[] };

    return "reused" in read
      ? (previous as { at: number; cards: AnnouncedCard[] })
      : read;
  })();

  return (await state.cards).cards;
};

/**
 * Whether the caller's `discovery.agents` filter lets it find a card: the
 * lists that the chain of starting agents passed down (every one must match),
 * and the agent's own list or the default.
 */
export const allowsAgent = (
  card: AnnouncedCard,
  options: DiscoveryToolSetOptions = {},
): boolean => {
  const { appId } = callerOf();
  const instance = getAsyncCtxSync()?.execution?.instance;
  const state = instance ? limitStateOf(instance, undefined) : undefined;
  const chain = state?.limits.discovery?.agents ?? [];
  const own = discoveryOptionsOf(options.discovery)?.agents;
  const lists = [...chain, own ?? defaultDiscovery];

  return lists.every((list) => {
    return matchesDiscovery(card, list, { appId });
  });
};

/**
 * The one error every refusal of `findCard` throws, whatever the reason: an
 * unknown address, one not shared with the caller's app, and one its
 * `discovery.agents` filter rejects all read the same. Asking about an agent
 * that is not shared with you must be indistinguishable from asking about
 * one that does not exist at all — any wording that differs between those
 * two (such as naming the agent back, or saying "may not start it" instead
 * of "is not shared") leaks that the agent exists by omission. `purpose` no
 * longer changes the wording; it is kept so a caller can log the two cases
 * apart on its own side without that distinction ever reaching the model.
 */
const notShared = (address: string): Error => {
  return new Error(
    `No agent "${address}" is shared with you. Use list_agents to see the ones that are.`,
  );
};

/**
 * The card of `address` if the caller may find it, else `notShared`. An
 * address that is unknown, one that is not shared with the caller and one
 * that its `discovery.agents` filter rejects all refuse with the identical
 * error (see `notShared`).
 */
export const findCard = async (
  address: string,
  options: DiscoveryToolSetOptions = {},
  _purpose: "describe" | "start" = "describe",
): Promise<AnnouncedCard> => {
  const { appId } = callerOf();
  const cards = await discoverCards(options);
  const found = cards.find((card) => {
    return card.address === address;
  });

  if (!found || found.kind === "tool" || !mayUse(found, appId)) {
    throw notShared(address);
  }

  if (!allowsAgent(found, options)) {
    throw notShared(address);
  }

  return found;
};

/**
 * Runs the definition's `discovery.prepare` over the input of a call to
 * another agent, with the run's trigger event and thread. Without one the
 * input is the model's own.
 */
export const prepareInput = async (
  discovery: AgentDiscovery | undefined,
  call: { card: AgentCard; input: Record<string, Json> },
): Promise<Record<string, Json>> => {
  const prepare = discoveryOptionsOf(discovery)?.prepare;

  if (!prepare) {
    return call.input;
  }

  const execution = getAsyncCtxSync()?.execution;

  if (!execution) {
    throw new Error("discovery.prepare must run inside an Inngest function");
  }

  const agent = (execution as { agent?: { thread?: string } }).agent;

  return prepare({
    ...call,
    event: execution.ctx.event,
    thread: { key: agent?.thread ?? "" },
  });
};

/**
 * Who else a `list_agents` answer is good for. Always `"private"`: the
 * answer depends on the caller's own `discovery.agents` and on which agents
 * are shared with its app, so it must never be reused for a different
 * caller.
 */
export type CacheScope = "private";

/**
 * What `list_agents` returns.
 */
export interface AgentRoster {
  /**
   * How long this answer stays good, in milliseconds. Equal to
   * `cardsFreshMs`: the same window a read of the cards is reused within a
   * run, since the roster is exactly as fresh as the cards it was built from.
   */
  ttlMs: number;

  /**
   * `"private"`: this roster is specific to the caller that asked for it
   * (its app, its `discovery.agents`) and must not be cached across callers.
   */
  cacheScope: CacheScope;

  /**
   * Every agent the caller may currently see.
   */
  agents: AgentSummary[];
}

/**
 * `list_agents` and `describe_agent`.
 */
export type DiscoveryToolSet = {
  list_agents: AgentTool<Record<string, never>, AgentRoster>;
  describe_agent: AgentTool<{ address: string }, AgentCard>;
};

/**
 * What `list_agents` returns, which its description shows the model.
 */
const listOutput = z.object({
  ttlMs: z.number(),
  cacheScope: z.literal("private"),
  agents: z.array(
    z.object({
      address: z.string(),
      description: z.string().optional(),
      capabilities: z.array(z.string()),
      skills: z
        .array(z.object({ name: z.string(), description: z.string() }))
        .optional(),
      effects: z.enum(["read", "write", "destructive"]),
      paused: z.boolean().optional(),
    }),
  ),
});

/**
 * The two tools that let an agent find other agents without naming them in
 * code.
 *
 * - `list_agents()`: every agent the caller can currently see.
 * - `describe_agent({ address })`: the whole card of one.
 *
 * An agent is visible to its own app, and to any app when its card says
 * `share: "team"`.
 */
export const discoveryToolSet = (
  options: DiscoveryToolSetOptions = {},
): DiscoveryToolSet => {
  return {
    list_agents: tool({
      id: "list_agents",
      group: true,
      description: {
        does: "Lists every agent you can start right now, with what each does. Agents you can't start, and you yourself, are never listed. Returns the whole list; there is no paging and no search.",
        use: "to find an agent for a piece of work",
        avoid:
          "to decide an agent doesn't exist from an old answer: the list can change while you run, so list again",
        context: `Agents can be added or removed while you run. The answer is good for ${cardsFreshMs}ms (its ttlMs) and is specific to you (cacheScope: "private").`,
      },
      input: z.object({}),
      output: listOutput,
      run: async () => {
        const { appId } = callerOf();
        const cards = await discoverCards(options);
        // The agent that calls is never one of the agents it can find. Naming
        // its own address in `describe_agent` or `start_agent` still works.
        const self = getAsyncCtxSync()?.execution?.agent?.ref;

        return {
          ttlMs: cardsFreshMs,
          cacheScope: "private" as const,
          agents: cards
            .filter((card) => {
              return (
                card.kind !== "tool" &&
                card.address !== self &&
                mayUse(card, appId) &&
                allowsAgent(card, options)
              );
            })
            .map(summaryOf),
        };
      },
    }),
    describe_agent: tool({
      id: "describe_agent",
      group: true,
      description: {
        does: "Shows one agent's whole card: what it does, its skills, its instructions and the input a start takes. It refuses an agent that isn't shared with you.",
        use: "before `start_agent` when you don't know the input an agent takes",
      },
      input: z.object({
        address: z.string().describe("The agent's address, `app/agent`."),
      }),
      run: async ({ address }: { address: string }) => {
        return publicCardOf(await findCard(address, options));
      },
    }),
  };
};

/**
 * The discovery tools an agent gets, from its definition's `discovery` field:
 * none unless it turns discovery on.
 */
export const discoveryToolsFor = (
  discovery: AgentDiscovery | undefined,
): Partial<DiscoveryToolSet> => {
  return discoveryOptionsOf(discovery) ? discoveryToolSet({ discovery }) : {};
};
