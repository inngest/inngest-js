/**
 * @module
 * EXPERIMENTAL: the filter behind `discovery.agents` and `discovery.tools`.
 * One list of entries decides what a model may find and what it may start.
 * An entry is an imported agent, an exact `"app/name"` address, or a filter
 * object of card fields that must all match.
 */

import type { AgentCard } from "./discovery.ts";

/**
 * A filter over card fields. Every field given must match; a list of filters
 * matches when any one does. It never matches a card with `explicit: true`.
 */
export interface DiscoveryFilter {
  /**
   * EXPERIMENTAL: the app part of the card's address. `"self"` is the app of
   * the agent that holds the filter.
   */
  app?: string;

  /**
   * EXPERIMENTAL: tags the card must all have.
   */
  tags?: string[];

  /**
   * EXPERIMENTAL: the card's `owner`.
   */
  owner?: string;

  /**
   * EXPERIMENTAL: the card's `effects`. A card without `effects` counts as
   * `"write"`.
   */
  effects?: "read" | "write";
}

/**
 * An entry of `discovery.agents` or `discovery.tools`: an imported agent (what
 * `agents.agent()` returns), an exact `"app/name"` address, or a
 * `DiscoveryFilter`. Only an imported agent or an address matches a card with
 * `explicit: true`.
 */
export type DiscoveryEntry = string | { address: string } | DiscoveryFilter;

/**
 * An entry as it travels to the agents a thread starts: an address or a filter,
 * with `app: "self"` already replaced by the app it meant.
 */
export type NormalizedDiscoveryEntry = string | DiscoveryFilter;

/**
 * What an agent allows by default when it sets no list: its own app, plus the
 * read-only agents of other apps (still subject to `share`).
 */
export const defaultDiscovery: DiscoveryFilter[] = [
  { app: "self" },
  { effects: "read" },
];

const filterKeys = ["app", "tags", "owner", "effects"];

const appOf = (address: string): string => {
  return address.slice(0, address.indexOf("/"));
};

/**
 * Whether a card passes a list of entries. An empty list matches nothing.
 */
export const matchesDiscovery = (
  /**
   * The card to test.
   */
  card: Pick<AgentCard, "address"> &
    Partial<Pick<AgentCard, "tags" | "owner" | "effects" | "explicit">>,

  /**
   * The entries: any one may match.
   */
  entries: readonly DiscoveryEntry[],

  /**
   * `appId` is the app that `"self"` means.
   */
  options: { appId: string },
): boolean => {
  return entries.some((entry) => {
    if (typeof entry === "string") {
      return card.address === entry;
    }

    if ("address" in entry && typeof entry.address === "string") {
      return card.address === entry.address;
    }

    if (card.explicit === true) {
      return false;
    }

    const filter = entry as DiscoveryFilter;

    if (filter.app !== undefined) {
      const app = filter.app === "self" ? options.appId : filter.app;

      if (appOf(card.address) !== app) {
        return false;
      }
    }

    if (
      filter.tags !== undefined &&
      !filter.tags.every((tag) => {
        return card.tags?.includes(tag) === true;
      })
    ) {
      return false;
    }

    if (filter.owner !== undefined && card.owner !== filter.owner) {
      return false;
    }

    if (
      filter.effects !== undefined &&
      (card.effects ?? "write") !== filter.effects
    ) {
      return false;
    }

    return true;
  });
};

/**
 * Throws when a `discovery.agents` or `discovery.tools` list is malformed, so a
 * typo never silently widens or empties what an agent can find.
 */
export const validateDiscoveryList = (
  /**
   * The agent's function ID, for the message.
   */
  agentId: string,

  /**
   * `"agents"` or `"tools"`.
   */
  field: "agents" | "tools",

  /**
   * The list from the definition.
   */
  list: unknown,
): void => {
  const where = `Agent "${agentId}": discovery.${field}`;

  if (list === undefined) {
    return;
  }

  if (!Array.isArray(list)) {
    throw new Error(`${where} must be a list of entries`);
  }

  for (const entry of list as unknown[]) {
    if (typeof entry === "string") {
      if (!/^[^/]+\/.+$/.test(entry)) {
        throw new Error(
          `${where} has the address "${entry}", which must look like "app/name"`,
        );
      }

      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        `${where} entries are an agent, an "app/name" address or a filter object`,
      );
    }

    const record = entry as Record<string, unknown>;

    if (typeof record.address === "string") {
      continue;
    }

    const keys = Object.keys(record).filter((key) => {
      return record[key] !== undefined;
    });
    const unknown = keys.find((key) => {
      return !filterKeys.includes(key);
    });

    if (unknown) {
      throw new Error(
        `${where} has a filter with "${unknown}"; its fields are ${filterKeys.join(", ")}`,
      );
    }

    if (keys.length === 0) {
      throw new Error(
        `${where} has an empty filter, which would match everything. Name at least one field`,
      );
    }

    const filter = record as DiscoveryFilter;

    if (
      (filter.app !== undefined && typeof filter.app !== "string") ||
      (filter.owner !== undefined && typeof filter.owner !== "string") ||
      (filter.effects !== undefined &&
        filter.effects !== "read" &&
        filter.effects !== "write") ||
      (filter.tags !== undefined &&
        (!Array.isArray(filter.tags) ||
          filter.tags.some((tag) => {
            return typeof tag !== "string";
          })))
    ) {
      throw new Error(
        `${where} has a filter with a bad value: app and owner are text, tags is a list of text, effects is "read" or "write"`,
      );
    }
  }
};

/**
 * Turns the entries of a list into what travels to started agents: an imported
 * agent becomes its address, and `app: "self"` becomes `appId`.
 */
export const normalizeDiscoveryList = (
  list: readonly DiscoveryEntry[],
  appId: string,
): NormalizedDiscoveryEntry[] => {
  return list.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }

    if ("address" in entry && typeof entry.address === "string") {
      return entry.address;
    }

    const filter = entry as DiscoveryFilter;

    return filter.app === "self" ? { ...filter, app: appId } : filter;
  });
};
