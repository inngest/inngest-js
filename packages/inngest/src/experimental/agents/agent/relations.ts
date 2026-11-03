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
 * The HMAC keys to check a tag against: the signing key and its fallback, or
 * the fixed key when there is none. The first one makes new tags.
 */
const secretsOf = (client: Inngest.Any): string[] => {
  const keys = [client.signingKey, client.signingKeyFallback]
    .filter((key): key is string => {
      return Boolean(key);
    })
    .map(removeSigningKeyPrefix);

  return keys.length > 0 ? keys : [unsignedKey];
};

const mac = (secret: string, ...parts: string[]): string => {
  return (
    hmac(sha256 as unknown as Parameters<typeof hmac>[0], secret)
      .update(parts.join("\n"))
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
  const tag = mac(secret, "tag", starter.key, starter.address, base);
  const escaped = encodeURIComponent(starter.address).replace(/\./g, "%2E");

  if (group === undefined) {
    return `${base}.${tag}.${escaped}`;
  }

  const id = mac(secret, "group", starter.key, group);

  return `${base}.${tag}.${id}.${mac(secret, "member", id, base)}.${escaped}`;
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
 */
export const groupId = (
  client: Inngest.Any,
  starter: string,
  group: string,
): string => {
  const [secret] = secretsOf(client) as [string];

  return mac(secret, "group", starter, group);
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

  if (mine && valid(mine.tag, "tag", target, mine.starter, mine.body)) {
    return mine.starter === ""
      ? undefined
      : { relation: "parent", address: mine.starter };
  }

  if (theirs && valid(theirs.tag, "tag", self, theirs.starter, theirs.body)) {
    return { relation: "child" };
  }

  if (
    mine?.group &&
    theirs?.group &&
    mine.group.id === theirs.group.id &&
    valid(mine.group.tag, "member", mine.group.id, mine.body) &&
    valid(theirs.group.tag, "member", theirs.group.id, theirs.body)
  ) {
    return { relation: "peer" };
  }

  return undefined;
};
