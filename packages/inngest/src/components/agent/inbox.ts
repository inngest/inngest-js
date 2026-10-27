/**
 * @module
 * EXPERIMENTAL: the durable store behind `step.subscribe()`. This is the one
 * place that decides where inbox messages and the per-thread cursor live, so a
 * platform-owned inbox can replace it without touching the rest. Today it is
 * Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
 */
import { connectRedis, type RedisClient } from "./redis.ts";

/**
 * One delivered inbox message.
 */
export interface InboxMessage<TData = unknown> {
  /**
   * Position in the inbox, starting at 1. Increases by one per message.
   */
  seq: number;
  data: TData;
}

/**
 * Messages per inbox key plus the cursor of the last message handed to a
 * reader. The cursor outlives runs, so a thread's next run continues where the
 * last one stopped.
 */
export interface InboxStore {
  /**
   * Adds a message and returns its sequence number.
   */
  append(key: string, data: unknown): Promise<number>;

  /**
   * Takes the next undelivered message and moves the cursor past it, or
   * returns `null` when there is none. Claiming twice with the same `owner`
   * returns the same message, so a retried step never loses one.
   */
  claim(key: string, owner: string): Promise<InboxMessage | null>;

  /**
   * The next undelivered message, without claiming it.
   */
  peek(key: string): Promise<InboxMessage | null>;

  /**
   * The newest sequence appended and the sequence last claimed (0 when none).
   */
  cursors(key: string): Promise<{ head: number; acked: number }>;
}

/**
 * How many claimed messages stay in the store for debugging. Older ones are
 * removed when a later message is claimed, so storage stays bounded.
 */
export const claimedTail = 50;

/**
 * An in-process store, for tests and local scripts.
 */
export function memoryInboxStore(): InboxStore {
  const inboxes = new Map<
    string,
    {
      msgs: Map<number, unknown>;
      head: number;
      acked: number;
      claims: Map<string, number>;
    }
  >();

  function inboxOf(key: string) {
    let found = inboxes.get(key);
    if (!found) {
      found = { msgs: new Map(), head: 0, acked: 0, claims: new Map() };
      inboxes.set(key, found);
    }

    return found;
  }

  return {
    async append(key, data) {
      const inbox = inboxOf(key);
      inbox.head += 1;
      inbox.msgs.set(inbox.head, JSON.parse(JSON.stringify(data)));

      return inbox.head;
    },
    async claim(key, owner) {
      const inbox = inboxOf(key);
      const prior = inbox.claims.get(owner);
      if (prior !== undefined) {
        return { seq: prior, data: inbox.msgs.get(prior) };
      }

      if (inbox.acked >= inbox.head) {
        return null;
      }

      inbox.acked += 1;
      inbox.claims.set(owner, inbox.acked);
      inbox.msgs.delete(inbox.acked - claimedTail);

      return { seq: inbox.acked, data: inbox.msgs.get(inbox.acked) };
    },
    async peek(key) {
      const inbox = inboxOf(key);
      if (inbox.acked >= inbox.head) {
        return null;
      }

      return { seq: inbox.acked + 1, data: inbox.msgs.get(inbox.acked + 1) };
    },
    async cursors(key) {
      const inbox = inboxOf(key);

      return { head: inbox.head, acked: inbox.acked };
    },
  };
}

const appendScript = `
local seq = redis.call('INCR', KEYS[1])
redis.call('HSET', KEYS[2], seq, ARGV[1])
return seq
`;

const claimScript = `
local prior = redis.call('HGET', KEYS[3], ARGV[1])
if prior then
  return {tonumber(prior), redis.call('HGET', KEYS[2], prior)}
end
local acked = tonumber(redis.call('GET', KEYS[4]) or '0')
local msg = redis.call('HGET', KEYS[2], acked + 1)
if not msg then
  return false
end
redis.call('SET', KEYS[4], acked + 1)
redis.call('HSET', KEYS[3], ARGV[1], acked + 1)
redis.call('EXPIRE', KEYS[3], 604800)
redis.call('HDEL', KEYS[2], acked + 1 - tonumber(ARGV[2]))
return {acked + 1, msg}
`;

/**
 * A Redis-backed store. Appends and claims are atomic Lua scripts.
 * @param url `redis://` or `rediss://` URL.
 */
export function redisInboxStore(url: string): InboxStore {
  let connection: Promise<RedisClient> | undefined;

  function client() {
    connection ??= connectRedis(url).catch((error) => {
      connection = undefined;
      throw error;
    });

    return connection;
  }

  function keys(key: string) {
    const base = `inngest:inbox:${key}`;

    return {
      head: `${base}:head`,
      msgs: `${base}:msgs`,
      claims: `${base}:claims`,
      acked: `${base}:acked`,
    };
  }

  return {
    async append(key, data) {
      const k = keys(key);
      const reply = await (await client()).command(
        "EVAL",
        appendScript,
        "2",
        k.head,
        k.msgs,
        JSON.stringify(data),
      );

      return Number(reply);
    },
    async claim(key, owner) {
      const k = keys(key);
      const reply = await (await client()).command(
        "EVAL",
        claimScript,
        "4",
        k.head,
        k.msgs,
        k.claims,
        k.acked,
        owner,
        String(claimedTail),
      );
      if (!Array.isArray(reply)) {
        return null;
      }

      return { seq: Number(reply[0]), data: JSON.parse(String(reply[1])) };
    },
    async peek(key) {
      const k = keys(key);
      const acked = Number(
        (await (await client()).command("GET", k.acked)) ?? 0,
      );
      const raw = await (await client()).command(
        "HGET",
        k.msgs,
        String(acked + 1),
      );

      return raw === null
        ? null
        : { seq: acked + 1, data: JSON.parse(String(raw)) };
    },
    async cursors(key) {
      const k = keys(key);
      const reply = (await (
        await client()
      ).command("MGET", k.head, k.acked)) as (string | null)[];

      return { head: Number(reply[0] ?? 0), acked: Number(reply[1] ?? 0) };
    },
  };
}

let shared: InboxStore | undefined;

/**
 * The store `step.subscribe` and thread handles use by default: Redis at
 * `INNGEST_EXPERIMENTAL_KV_URL`.
 */
export function defaultInboxStore(): InboxStore {
  if (!shared) {
    const url = process.env.INNGEST_EXPERIMENTAL_KV_URL;
    if (!url) {
      throw new Error(
        "step.subscribe needs a store: set INNGEST_EXPERIMENTAL_KV_URL (redis:// or rediss://) or pass `store`.",
      );
    }
    shared = redisInboxStore(url);
  }

  return shared;
}
