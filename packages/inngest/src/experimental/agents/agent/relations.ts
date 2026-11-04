/**
 * @module
 * EXPERIMENTAL: who a model's `message_agent`, `ask_agent` and `stop_agent` may
 * reach, decided from thread keys alone, with no stored state.
 *
 * A thread that `start()` or `start_agent` opens gets a key that carries a tag
 * binding it to the thread that started it:
 *
 *     <address>:<runId>.<n>.<tag>.<starter>
 *     <address>:<runId>.<n>.<tag>.<group>.<groupTag>.<starter>   (with a `group`)
 *
 * - `starter` is the starting agent's address, escaped, so a child can message
 *   its parent: a parent's own thread key (a trigger's `thread` expression,
 *   say) need not name its agent.
 * - `tag` is an HMAC of the starter's thread key, its address and the rest of
 *   the key. Given
 *   its own key and a candidate key, a thread can tell whether the candidate
 *   started it (the parent) or it started the candidate (a child), in any run
 *   of the thread, because the tag does not depend on which run asks.
 * - `group` is an HMAC of the starter's thread key and the group's name, and
 *   `groupTag` binds it to this key. Two keys with the same valid `group` were
 *   started by the same thread under the same group name: peers.
 *
 * The HMAC key is the client's signing key, which a model never sees, so a
 * model cannot make a key that passes: a forged key is refused, which also
 * keeps a message to a thread that was never started (it would start a run)
 * from being sent. With no signing key (a Dev Server) the tags use a fixed
 * public key, which stops accidents but not a deliberate forgery.
 */

import hashjs from "hash.js";
import type { Inngest } from "../../../components/Inngest.ts";
import { removeSigningKeyPrefix } from "../../../helpers/strings.ts";

const { hmac, sha256 } = hashjs;

/**
 * The HMAC key used when the client has no signing key.
 */
const unsignedKey = "inngest-agents-unsigned";

/**
 * What the HMACs need of a client: its signing key and its fallback.
 */
export interface SigningKeys {
  signingKey?: string;
  signingKeyFallback?: string;
}

/**
 * The HMAC keys to check a tag against: the signing key and its fallback, or
 * the fixed key when there is none. The first one makes new tags.
 */
export const secretsOf = (client: SigningKeys): string[] => {
  const keys = [client.signingKey, client.signingKeyFallback]
    .filter((key): key is string => {
      return Boolean(key);
    })
    .map(removeSigningKeyPrefix);

  return keys.length > 0 ? keys : [unsignedKey];
};

/**
 * The app a thread key belongs to: the part of its agent address before the
 * first slash. A tag is made by the app that owns the key it tags, so it is
 * checked against that app, and a tag made for one app is refused by another.
 */
const appOfBody = (body: string): string => {
  const slash = body.indexOf("/");

  return slash < 0 ? "" : body.slice(0, slash);
};

/**
 * The HMAC of `parts`, which are encoded as a JSON array, so no part can move
 * a boundary into its neighbour (a starter address is URI-decoded and may hold
 * any character, newlines included).
 */
const mac = (secret: string, ...parts: string[]): string => {
  return (
    hmac(sha256 as unknown as Parameters<typeof hmac>[0], secret)
      .update(JSON.stringify(parts))
      // 16 hex characters (64 bits) keep keys short.
      .digest("hex")
      .slice(0, 16)
  );
};

/**
 * A thread key taken apart.
 */
interface ParsedKey {
  body: string;
  tag: string;
  starter: string;
  group?: { id: string; tag: string };
}

const parseKey = (key: string): ParsedKey | undefined => {
  const colon = key.lastIndexOf(":");

  if (colon < 0) {
    return undefined;
  }

  const parts = key.slice(colon + 1).split(".");

  if (parts.length !== 4 && parts.length !== 6) {
    return undefined;
  }

  const [runId, n, tag, ...rest] = parts as string[];
  const body = `${key.slice(0, colon)}:${runId}.${n}`;
  const starter = decodeURIComponent(rest[rest.length - 1] as string);

  return {
    body,
    tag: tag as string,
    starter,
    ...(rest.length === 3 && {
      group: { id: rest[0] as string, tag: rest[1] as string },
    }),
  };
};

/**
 * The agent address a tagged key (one a start made) names, or `undefined` for
 * a key of any other shape. A run of an agent whose own address is not this
 * one must not act under the key: it would borrow the relations the key's
 * tag proves.
 * @param key A thread key.
 */
export const taggedKeyAddress = (key: string): string | undefined => {
  const parsed = parseKey(key);

  return parsed && /^[0-9a-f]{16}$/.test(parsed.tag)
    ? key.slice(0, key.lastIndexOf(":"))
    : undefined;
};

/**
 * The key of a thread a start opens, tagged with the thread that started it.
 * @param client The client, whose signing key makes the tags.
 * @param base `<address>:<runId>.<n>`.
 * @param starter The thread that starts it: its key, and its agent's address
 * (empty when a plain function starts it).
 * @param group The name of the group it joins.
 */
export const relatedKey = (
  client: Inngest.Any,
  base: string,
  starter: { key: string; address: string },
  group?: string,
): string => {
  const [secret] = secretsOf(client) as [string];
  const app = client.id;
  const tag = mac(secret, "tag", app, starter.key, starter.address, base);
  const escaped = encodeURIComponent(starter.address).replace(/\./g, "%2E");

  if (group === undefined) {
    return `${base}.${tag}.${escaped}`;
  }

  const id = groupIdOf(secret, starter.key, starter.address, group);

  return `${base}.${tag}.${id}.${mac(secret, "member", app, id, base)}.${escaped}`;
};

/**
 * The id of a group: bound to the starter's app (taken from its address, so
 * peers started by one thread in different apps still share it), the
 * starter's key and the group's name.
 */
const groupIdOf = (
  secret: string,
  starterKey: string,
  starterAddress: string,
  group: string,
): string => {
  return mac(secret, "group", appOfBody(starterAddress), starterKey, group);
};

/**
 * The address of the agent a started thread belongs to: the part of its key
 * before the run, which `start_agent` starts the key with. `undefined` for a
 * key that was not made by a start.
 * @param key A thread key.
 */
export const agentOfKey = (key: string): string | undefined => {
  const colon = key.lastIndexOf(":");

  return parseKey(key) && colon > 0 ? key.slice(0, colon) : undefined;
};

/**
 * The id of the group `group` of the thread `starter`, which is also what the
 * members' keys carry. It is `undefined` for a key that is not a group member's.
 * @param key A thread key.
 */
export const groupOf = (key: string): string | undefined => {
  return parseKey(key)?.group?.id;
};

/**
 * The id of the group a start by `starter` with the name `group` joins.
 * @param client The client.
 * @param starter The key of the thread that starts.
 * @param group The group's name.
 * @param starterAddress The starting agent's address (empty for a function).
 */
export const groupId = (
  client: Inngest.Any,
  starter: string,
  group: string,
  starterAddress = "",
): string => {
  const [secret] = secretsOf(client) as [string];

  return groupIdOf(secret, starter, starterAddress, group);
};

/**
 * How `target` relates to `self`: the thread that started it (`parent`, with
 * the parent's agent address), a thread it started (`child`), a member of the
 * group it is in (`peer`), or `undefined` for anything else, including a key
 * that was not made by a start, and a parent that is not an agent.
 * @param client The client.
 * @param self The key of the thread asking.
 * @param target The key it wants to reach.
 */
export const relationOf = (
  client: Inngest.Any,
  self: string,
  target: string,
): { relation: "parent" | "child" | "peer"; address?: string } | undefined => {
  if (self === target) {
    return undefined;
  }

  const secrets = secretsOf(client);
  const mine = parseKey(self);
  const theirs = parseKey(target);
  const valid = (given: string, ...parts: string[]) => {
    return secrets.some((secret) => {
      return mac(secret, ...parts) === given;
    });
  };

  if (
    mine &&
    valid(
      mine.tag,
      "tag",
      appOfBody(mine.body),
      target,
      mine.starter,
      mine.body,
    )
  ) {
    return mine.starter === ""
      ? undefined
      : { relation: "parent", address: mine.starter };
  }

  if (
    theirs &&
    valid(
      theirs.tag,
      "tag",
      appOfBody(theirs.body),
      self,
      theirs.starter,
      theirs.body,
    )
  ) {
    return { relation: "child" };
  }

  if (
    mine?.group &&
    theirs?.group &&
    mine.group.id === theirs.group.id &&
    valid(
      mine.group.tag,
      "member",
      appOfBody(mine.body),
      mine.group.id,
      mine.body,
    ) &&
    valid(
      theirs.group.tag,
      "member",
      appOfBody(theirs.body),
      theirs.group.id,
      theirs.body,
    )
  ) {
    return { relation: "peer" };
  }

  return undefined;
};

/**
 * The value with every object's keys in order: the executor may reorder keys
 * on the way, and the signature must not depend on it.
 */
export const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => {
          return a < b ? -1 : a > b ? 1 : 0;
        })
        .map(([key, inner]) => {
          return [key, canonical(inner)];
        }),
    );
  }

  return value;
};

export const fullMac = (secret: string, data: string): string => {
  return hmac(sha256 as unknown as Parameters<typeof hmac>[0], secret)
    .update(data)
    .digest("hex");
};

/**
 * Signs an app's announcement of its cards, so a reader can tell it was made
 * by something that holds the environment's signing key and not by someone
 * who can only send events. The signature covers the app ID and the cards
 * (keys sorted at every level), so it cannot be moved to another app or edited.
 * It does not tell one app of the environment from another: they share the key.
 * @param client The announcing app's client.
 * @param cards The cards announced.
 */
export const signCards = (client: Inngest.Any, cards: unknown): string => {
  const [secret] = secretsOf(client) as [string];

  return fullMac(
    secret,
    JSON.stringify(["cards", client.id, canonical(cards)]),
  );
};

/**
 * Whether an announcement of `app` carries a signature made over its cards.
 * @param client The reading app's client, whose signing key (or fallback) checks.
 * @param app The app the announcement names.
 * @param cards The cards it lists.
 * @param signature The signature that came with it.
 */
export const cardsAreSigned = (
  client: Inngest.Any,
  app: string,
  cards: unknown,
  signature: unknown,
): boolean => {
  if (typeof signature !== "string") {
    return false;
  }

  const data = JSON.stringify(["cards", app, canonical(cards)]);

  return secretsOf(client).some((secret) => {
    return fullMac(secret, data) === signature;
  });
};

/**
 * What signs an event of the thread ledger: the app that made it and the HMAC
 * of its data.
 */
export type LedgerSignature = {
  by: string;
  sig: string;
};

const ledgerDigest = (
  name: string,
  by: string,
  data: Record<string, unknown>,
): string => {
  const { sig: _sig, ...rest } = data;

  return JSON.stringify(["ledger", name, by, canonical({ ...rest, by })]);
};

/**
 * Signs the data of a ledger event with the signing key and the app ID of the
 * signer. The signature covers the event's name and all of its data (keys
 * sorted at every level), so it cannot be moved to another event or edited.
 * Any app of the environment may sign, because they share the key; what the
 * signature proves is that the sender holds it, which a model and a holder of
 * only an event key do not.
 * @param client The signer's client: its app ID and signing key.
 * @param name The event's name.
 * @param data The event's data, without `by` and `sig`.
 * @returns The data with `by` and `sig` added.
 */
export const signLedgerData = <T extends Record<string, unknown>>(
  client: SigningKeys & { id: string },
  name: string,
  data: T,
): T & LedgerSignature => {
  const [secret] = secretsOf(client) as [string];

  return {
    ...data,
    by: client.id,
    sig: fullMac(secret, ledgerDigest(name, client.id, data)),
  };
};

/**
 * Whether the data of a ledger event carries a signature made by a holder of
 * this environment's signing key (or its fallback).
 * @param client The checking app's client.
 * @param name The event's name.
 * @param data The event's data, with `by` and `sig`.
 */
export const ledgerDataIsSigned = (
  client: SigningKeys,
  name: string,
  data: unknown,
): boolean => {
  const given = data as Record<string, unknown> | null | undefined;

  if (
    typeof given !== "object" ||
    given === null ||
    typeof given.sig !== "string" ||
    typeof given.by !== "string"
  ) {
    return false;
  }

  const digest = ledgerDigest(name, given.by, given);

  return secretsOf(client).some((secret) => {
    return fullMac(secret, digest) === given.sig;
  });
};
