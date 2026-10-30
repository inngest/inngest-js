/**
 * @module
 * EXPERIMENTAL: agent discovery. Every agent has a card that says what it does,
 * what it accepts, how to message it and who may use it. An app announces its
 * cards in an `agents/registered` event (when `agents.announce()` is called and
 * on a daily heartbeat), and the four discovery tools read the latest card of
 * each agent back from the events API, so agents find and call each other
 * across apps of one environment without naming each other in code.
 */

import { z } from "zod/v4";
import { internalEvents } from "../../helpers/consts.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { step } from "../InngestStepTools.ts";
import {
  type AgentTool,
  toJsonSchema,
  tool,
  triggerSchema,
} from "../sandbox/tools.ts";
import { EventType } from "../triggers/triggers.ts";
import { invokeAgent } from "./invoke.ts";
import { getThread } from "./thread.ts";

/**
 * The name of the event an app sends with its cards.
 */
export const agentsRegisteredEvent = "agents/registered";

/**
 * The name of the event that makes an app send its cards again.
 */
export const agentsAnnounceEvent = "agents/announce";

/**
 * Who may find and use an agent. `"private"`: only agents of its own app.
 * `"team"`: any agent in the environment.
 */
export type AgentShare = "private" | "team";

/**
 * What a call to an agent does to the world, after MCP's tool hints.
 */
export type AgentEffects = "read" | "write" | "needs-approval";

/**
 * One thing an agent is good at. Models pick agents by these.
 */
export interface AgentSkill {
  /**
   * A short ID.
   */
  id: string;

  /**
   * What the agent does for this skill.
   */
  description: string;

  /**
   * Example requests.
   */
  examples: string[];
}

/**
 * What an agent publishes about itself. The SDK writes every field from the
 * agent's definition, except the authored ones (`skills`, `owner`, `effects`,
 * `speed`), which the config sets.
 *
 * TODO: `describe_agent` may add live stats (success rate, duration, scores)
 * derived from runs. They are not part of the card.
 */
export interface AgentCard {
  /**
   * The agent's function ID within its app.
   */
  agentId: string;

  /**
   * The app that serves the agent.
   */
  app: string;

  /**
   * The qualified function ID, `"<app>-<agentId>"`, as `step.invoke` and the
   * Inngest API know it.
   */
  functionId: string;

  /**
   * What the agent does, from its `description`.
   */
  does?: string;

  /**
   * How to call the agent with `call_agent`.
   */
  call: {
    /**
     * JSON Schema of the input, from the `invoke()` trigger. Without it a
     * call takes `{ message }`.
     */
    input?: Record<string, unknown>;
  };

  /**
   * What a call returns: its schema when known, else a short description.
   */
  output: Record<string, unknown> | string;

  /**
   * How to message the agent: send `event` with `data`, where `agent` is
   * `"<app>/<agentId>"`, `thread` is a thread key the sender chooses (a
   * thread keeps its conversation) and `text` is the message.
   */
  message: {
    event: "agent/message";
    data: { agent: string; thread: "<thread key>"; text: "<message>" };
  };

  /**
   * What starts the agent: event names and cron expressions.
   */
  triggers: { event?: string; cron?: string }[];

  /**
   * Who may find and use the agent.
   */
  share: AgentShare;

  /**
   * A hash of the rest of the card, so a reader sees when it changed.
   */
  version: string;

  /**
   * How to use the agent: `"conversation"` (message a thread, which every
   * agent supports) or `"both"` (it also has an `invoke()` trigger, so
   * `call_agent` hands it typed input).
   */
  mode: "call" | "conversation" | "both";

  /**
   * What the agent is good at. Authored.
   */
  skills?: AgentSkill[];

  /**
   * The team or person who owns the agent. Authored.
   */
  owner?: string;

  /**
   * What a call does to the world. Authored; `"write"` when not set.
   */
  effects: AgentEffects;

  /**
   * How long a call takes. Authored.
   */
  speed?: "seconds" | "minutes";
}

/**
 * The authored part of a card, set in an agent's config.
 */
export interface AgentCardConfig {
  /**
   * What the agent does. Also the model-facing description when the agent is
   * a tool.
   */
  description?: string;

  /**
   * Who may find and use the agent. Default `"private"`.
   */
  share?: AgentShare;

  /**
   * What the agent is good at. This drives which agent a model picks most.
   */
  skills?: AgentSkill[];

  /**
   * The team or person who owns the agent.
   */
  owner?: string;

  /**
   * What a call does: `"read"`, `"write"` or `"needs-approval"`. Default
   * `"write"`.
   */
  effects?: AgentEffects;

  /**
   * How long a call takes.
   */
  speed?: "seconds" | "minutes";
}

/**
 * The data of `agents/registered`.
 */
export interface AgentsRegisteredData {
  /**
   * The app that announced.
   */
  app: string;

  /**
   * The cards of the app's agents.
   */
  cards: AgentCard[];
}

/**
 * The cards of each client's agents, by agent ID.
 */
const cardsByClient = new WeakMap<object, Map<string, AgentCard>>();

/**
 * The address of the agent of a card, `"<app>/<agentId>"`, what the tools
 * take as `id`.
 */
export const addressOf = (card: Pick<AgentCard, "app" | "agentId">): string => {
  return `${card.app}/${card.agentId}`;
};

/**
 * A short hash of a string (FNV-1a), for `version`.
 */
const hashOf = (text: string): string => {
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
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
   * The agent's function, which says what triggers it and what it accepts.
   */
  fn: InngestFunction.Any,

  /**
   * The agent's config.
   */
  config: AgentCardConfig,
): AgentCard => {
  const schema = triggerSchema(fn, true);
  let input: Record<string, unknown> | undefined;

  if (schema) {
    try {
      input = toJsonSchema(agentId, schema);
    } catch {
      // A schema that cannot become JSON Schema (zod 3, say) still means the
      // agent takes typed input, so a call must not fall back to `{ message }`.
      input = { type: "object" };
    }
  }

  const own = new Set<string>([
    "agent/message",
    "agent/steer",
    "agent/stop",
    "agent/request",
  ]);
  const all: { event?: string; cron?: string }[] = (
    (fn.opts.triggers ?? []) as { event?: unknown; cron?: string }[]
  ).map((trigger) => {
    if (trigger.cron) {
      return { cron: trigger.cron };
    }

    return {
      event:
        trigger.event instanceof EventType
          ? trigger.event.name
          : String(trigger.event),
    };
  });

  // The thread events every agent has are its inbox, in `message`.
  const triggers = all.filter((trigger) => {
    return !(trigger.event && own.has(trigger.event));
  });
  const invokable = triggers.some((trigger) => {
    return trigger.event === internalEvents.FunctionInvoked;
  });
  const body: Omit<AgentCard, "version"> = {
    agentId,
    app,
    functionId: `${app}-${agentId}`,
    ...(config.description !== undefined && { does: config.description }),
    call: { ...(input && { input }) },
    output: "The agent's final result.",
    message: {
      event: "agent/message",
      data: {
        agent: `${app}/${agentId}`,
        thread: "<thread key>",
        text: "<message>",
      },
    },
    triggers,
    share: config.share ?? "private",
    mode: invokable ? "both" : "conversation",
    ...(config.skills && { skills: config.skills }),
    ...(config.owner !== undefined && { owner: config.owner }),
    effects: config.effects ?? "write",
    ...(config.speed && { speed: config.speed }),
  };

  return { ...body, version: hashOf(JSON.stringify(body)) };
};

/**
 * Remembers the card of an agent of `client`, for `announce()`.
 */
export const rememberCard = (client: object, card: AgentCard): void => {
  const cards = cardsByClient.get(client) ?? new Map<string, AgentCard>();

  cards.set(card.agentId, card);
  cardsByClient.set(client, cards);
};

/**
 * The cards of the agents `client` serves.
 */
export const cardsOf = (client: object): AgentCard[] => {
  return [...(cardsByClient.get(client)?.values() ?? [])];
};

/**
 * The event of an app's announcement.
 */
export const announcement = (
  client: Inngest.Any,
): { name: string; data: AgentsRegisteredData } => {
  return {
    name: agentsRegisteredEvent,
    data: { app: client.id, cards: cardsOf(client) },
  };
};

const pageSize = 50;
const maxPages = 20;

/**
 * Reads the latest card of every agent announced in the environment, newest
 * announcement first. Needs the events API (the Dev Server and Cloud serve it).
 */
export const readCards = async (client: Inngest.Any): Promise<AgentCard[]> => {
  const latest = new Map<string, AgentCard>();
  const announced = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const events = await client.listEvents({
      name: agentsRegisteredEvent,
      limit: pageSize,
      cursor,
    });

    for (const event of events) {
      const data = event.data as Partial<AgentsRegisteredData> | undefined;

      // The newest announcement of an app is all of its cards: an agent it
      // no longer lists, or lists as private now, drops out.
      if (!data?.app || announced.has(data.app)) {
        continue;
      }

      announced.add(data.app);

      for (const card of data.cards ?? []) {
        // A card is its app's own: one that names another app, or a function
        // ID that is not its app and agent, is ignored.
        if (
          !card?.agentId ||
          card.app !== data.app ||
          card.functionId !== `${card.app}-${card.agentId}`
        ) {
          continue;
        }

        latest.set(addressOf(card), card);
      }
    }

    if (events.length < pageSize) {
      break;
    }

    cursor = events[events.length - 1]?.internalId;
  }

  return [...latest.values()];
};

/**
 * Whether `caller` may find and use the agent of `card`.
 */
export const mayUse = (card: AgentCard, caller: string): boolean => {
  return card.share === "team" || card.app === caller;
};

const words = (text: string): string[] => {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => {
      return word.length > 0;
    });
};

/**
 * The cards that match a free-text query: those that contain any of its words
 * in their ID, description or triggers, best matches first. No query matches
 * every card.
 */
export const matchCards = (cards: AgentCard[], query?: string): AgentCard[] => {
  const wanted = words(query ?? "");

  if (wanted.length === 0) {
    return cards;
  }

  return cards
    .map((card) => {
      const text = [
        addressOf(card),
        card.does ?? "",
        ...(card.skills ?? []).flatMap((skill) => {
          return [skill.id, skill.description, ...skill.examples];
        }),
        ...card.triggers.map((trigger) => {
          return trigger.event ?? trigger.cron ?? "";
        }),
      ].join(" ");
      const have = new Set(words(text));
      const score = wanted.filter((word) => {
        return have.has(word) || text.toLowerCase().includes(word);
      }).length;

      return { card, score };
    })
    .filter((entry) => {
      return entry.score > 0;
    })
    .sort((a, b) => {
      return b.score - a.score;
    })
    .map((entry) => {
      return entry.card;
    });
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
 * The card of `id` if the caller may use it, else an error that says why.
 */
const visibleCard = async (
  client: Inngest.Any,
  appId: string,
  id: string,
): Promise<AgentCard> => {
  const cards = await readCards(client);
  const card = cards.find((candidate) => {
    return addressOf(candidate) === id;
  });

  if (!card || !mayUse(card, appId)) {
    throw new Error(
      `No agent "${id}" is shared with you. Use list_agents to see the ones that are.`,
    );
  }

  return card;
};

const summary = (card: AgentCard) => {
  return {
    id: addressOf(card),
    description: card.does,
    mode: card.mode,
    effects: card.effects,
    skills: card.skills,
    share: card.share,
    typedInput: card.call.input !== undefined,
  };
};

/**
 * Starts the agent of `card` with `input` and waits for its result. An agent
 * without a typed input reads `input.message` as a message to a thread.
 */
const startCall = (
  card: AgentCard,
  input: Record<string, unknown>,
  options: { id?: string } = {},
): Promise<unknown> => {
  const text = typeof input.message === "string" ? input.message : "";

  if (!card.call.input && !text) {
    throw new Error(
      `${addressOf(card)} takes no typed input: pass { "message": "<text>" }.`,
    );
  }

  return invokeAgent(
    { ref: addressOf(card) },
    card.call.input
      ? input
      : (thread) => {
          return { agent: addressOf(card), thread, text };
        },
    options.id ? { id: options.id } : {},
    false,
  );
};

/**
 * EXPERIMENTAL: The agents shared with the caller that match `query` (all of
 * them without one), as cards. Call it inside a function: it is the code
 * version of `list_agents`, for a function that is not a model loop. The read
 * is a step, so a replay sees the same agents.
 */
export const findAgents = async (query?: string): Promise<AgentCard[]> => {
  const { client, appId } = callerOf();
  const cards = (await step.run(`discover:find:${query ?? ""}`, async () => {
    return readCards(client);
  })) as AgentCard[];

  return matchCards(
    cards.filter((card) => {
      return mayUse(card, appId);
    }),
    query,
  );
};

/**
 * EXPERIMENTAL: Starts the agent `id` (its `"<app>/<agentId>"`, from a card)
 * with `input` and waits for its result. Call it inside a function: it is the
 * code version of `call_agent`, with the same sharing check. An agent without
 * a typed input takes `{ message }`.
 */
export const callAgent = async (
  id: string,
  input: Record<string, unknown>,
  options: { id?: string } = {},
): Promise<unknown> => {
  const { client, appId } = callerOf();
  const card = (await step.run(`discover:${id}`, async () => {
    return visibleCard(client, appId, id);
  })) as AgentCard;

  return startCall(card, input, options);
};

/**
 * Options of `discoveryTools()`.
 */
export interface DiscoveryToolsOptions {
  /**
   * Handles a call the model made with `background: true`: the tool answers
   * `{ started: true }` at once and the agent keeps running, so a thread can
   * go on while an agent that takes hours works. `result` settles with the
   * agent's result, or rejects when it fails or is cancelled. Without a
   * handler, `background` is refused.
   */
  onBackground?: (call: { id: string; result: Promise<unknown> }) => void;

  /**
   * Fills in what the caller knows and the model must not make up, such as who
   * is asking, before `call_agent` hands `input` to the agent. It gets the
   * card, so it can act on what the agent asks for. Return the input to use.
   */
  prepare?: (call: {
    card: AgentCard;
    input: Record<string, unknown>;
  }) => Record<string, unknown>;
}

/**
 * The four discovery tools, by tool name.
 */
export type DiscoveryTools = {
  list_agents: AgentTool;
  describe_agent: AgentTool;
  call_agent: AgentTool;
  message_agent: AgentTool;
};

/**
 * EXPERIMENTAL: The tools that let an agent find, call and message other
 * agents without naming them in code. Pass them to `agent.loop()` as `tools`,
 * or to `sandbox.tools.code({ tools })`.
 *
 * - `list_agents({ query? })`: the agents shared with the caller that match.
 * - `describe_agent({ id })`: the full card of one.
 * - `call_agent({ id, input })`: starts the agent and returns its result.
 * - `message_agent({ id, thread, text })`: sends `agent/message` to its inbox.
 *
 * An agent is visible to its own app, and to any app when its `share` is
 * `"team"`. The call tools check this again, so an ID the model made up or
 * remembered does not get around it.
 */
export const discoveryTools = (
  options: DiscoveryToolsOptions = {},
): DiscoveryTools => {
  return {
    list_agents: tool({
      id: "list_agents",
      description:
        "Lists the agents you can call or message, with what each does. Pass a few words in `query` to narrow the list.",
      input: z.object({
        query: z.string().optional().describe("Words to look for."),
      }),
      run: async ({ query }: { query?: string }) => {
        const { client, appId } = callerOf();
        const cards = await readCards(client);

        return {
          agents: matchCards(
            cards.filter((card) => {
              return mayUse(card, appId);
            }),
            query,
          ).map(summary),
        };
      },
    }),
    describe_agent: tool({
      id: "describe_agent",
      description:
        "The full card of one agent: what it does, the input a call takes, how to message it and what starts it.",
      input: z.object({ id: z.string().describe("The agent's id.") }),
      run: async ({ id }: { id: string }) => {
        const { client, appId } = callerOf();

        return visibleCard(client, appId, id);
      },
    }),
    call_agent: tool({
      id: "call_agent",
      group: true,
      description:
        "Starts an agent and returns what it answers. `input` is what describe_agent says the agent accepts; an agent without a typed input takes `{ message: string }`.",
      input: z.object({
        id: z.string().describe("The agent's id."),
        input: z
          .record(z.string(), z.unknown())
          .describe("What to hand the agent."),
        background: z
          .boolean()
          .optional()
          .describe(
            "Answer at once and carry on while the agent works; its result reaches you later. For agents that take minutes or more.",
          ),
      }),
      run: async ({
        id,
        input,
        background,
      }: {
        id: string;
        input: Record<string, unknown>;
        background?: boolean;
      }) => {
        const { client, appId } = callerOf();
        const card = (await step.run(`discover:${id}`, async () => {
          return visibleCard(client, appId, id);
        })) as AgentCard;

        if (background && !options.onBackground) {
          throw new Error("This caller does not take background calls.");
        }

        const call = startCall(
          card,
          options.prepare ? options.prepare({ card, input }) : input,
        );

        if (!background || !options.onBackground) {
          return call;
        }

        // The invoke is a step of the run like any other; the run goes on
        // while it is in flight, and the handler gets what it settles with.
        call.catch(() => {
          // The handler owns the outcome.
        });
        options.onBackground({ id: addressOf(card), result: call });

        return { started: true, agent: addressOf(card) };
      },
    }),
    message_agent: tool({
      id: "message_agent",
      group: true,
      description:
        "Sends a message to an agent's thread without waiting for an answer. A thread you reuse keeps its conversation.",
      input: z.object({
        id: z.string().describe("The agent's id."),
        thread: z.string().describe("The thread key to message."),
        text: z.string().describe("The message."),
      }),
      run: async ({
        id,
        thread,
        text,
      }: {
        id: string;
        thread: string;
        text: string;
      }) => {
        const { client, appId } = callerOf();
        const card = (await step.run(`discover:${id}`, async () => {
          return visibleCard(client, appId, id);
        })) as AgentCard;

        await getThread(client, addressOf(card), thread).send(text);

        return { sent: true, agent: addressOf(card), thread };
      },
    }),
  };
};
