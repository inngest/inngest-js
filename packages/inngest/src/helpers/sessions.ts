import type { EventMeta, EventSessions } from "../types.ts";

/**
 * Validates event sessions and normalizes their values to strings, matching
 * the shape stored by the Inngest server.
 *
 * Returns `undefined` if no sessions were given.
 */
export const normalizeEventSessions = (
  sessions: EventSessions | null | undefined,
): Record<string, string> | undefined => {
  if (sessions === undefined || sessions === null) {
    return undefined;
  }
  if (typeof sessions !== "object" || Array.isArray(sessions)) {
    throw new Error("Event sessions must be an object");
  }

  const entries = Object.entries(sessions);
  if (entries.length === 0) {
    return undefined;
  }

  // Collected as entries and built with Object.fromEntries so that special
  // keys like "__proto__" become own properties instead of being silently
  // dropped by a plain object assignment.
  const normalized: [string, string][] = [];
  for (const [key, value] of entries) {
    if (!key) {
      throw new Error("Event session keys cannot be empty");
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`Event session "${key}" must be a string or number`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Event session "${key}" must be a finite number`);
    }

    const id = String(value);
    if (!id) {
      throw new Error(`Event session "${key}" cannot have an empty ID`);
    }

    normalized.push([key, id]);
  }

  return Object.fromEntries(normalized);
};

export const normalizeEventMeta = (
  meta: EventMeta | null | undefined,
): NormalizedEventMeta | undefined => {
  if (meta === undefined || meta === null) {
    return undefined;
  }
  if (typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("Event meta must be an object");
  }

  const sessions = normalizeEventSessions(meta.sessions);
  const propagatedSessions = normalizeEventSessions(meta.propagatedSessions);
  if (sessions === undefined && propagatedSessions === undefined) {
    return undefined;
  }

  const out: NormalizedEventMeta = {};
  if (sessions !== undefined) {
    out.sessions = sessions;
  }
  if (propagatedSessions !== undefined) {
    out.propagatedSessions = propagatedSessions;
  }

  return out;
};

type NormalizedEventMeta = {
  sessions?: Record<string, string>;
  propagatedSessions?: Record<string, string>;
};

/**
 * Maximum sessions carried on a single event. Mirrors the server's
 * `consts.MaxEventSessions`; the propagated aggregate is truncated to this so
 * the emitted event passes ingest validation.
 */
const MAX_EVENT_SESSIONS = 5;

const utf8Encoder = new TextEncoder();

/**
 * Compares two strings by their UTF-8 byte sequences, matching the server's
 * native string ordering (Go's `cmp.Compare`, which is byte-wise over UTF-8).
 *
 * JavaScript's default `<` / `Array.prototype.sort` compares UTF-16 code units,
 * which diverges from UTF-8 byte order for characters outside the BMP (surrogate
 * pairs sort below `U+E000..U+FFFF` by code unit but above them by code point).
 * Session keys have no charset restriction server-side, so we encode and compare
 * bytes to stay byte-for-byte identical to server-side truncation. See the
 * session-propagation design (collation decision).
 */
export const compareUtf8 = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  const ab = utf8Encoder.encode(a);
  const bb = utf8Encoder.encode(b);
  const len = Math.min(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    if (ab[i] !== bb[i]) {
      return ab[i]! - bb[i]!;
    }
  }
  return ab.length - bb.length;
};

/**
 * Reduces a run's triggering events to `≤5` deterministic sessions that
 * become the propagated sessions.
 */
export const reduceEventsToPropagatedSessions = (
  // Accepts the send-time EventMeta shape (numeric ids permitted) since that is
  // how a run's triggering events are statically typed; ids are canonicalized
  // to strings below, so received string ids pass through unchanged.
  events: ReadonlyArray<{ meta?: EventMeta | null }>,
): Record<string, string> => {
  // Group the sessions by key

  // A Map (not a plain object) sidesteps `__proto__`/prototype-key footguns
  // while collecting.
  const idsByKey = new Map<string, Set<string>>();
  for (const event of events) {
    const sessions = event?.meta?.sessions;
    if (!sessions) {
      continue;
    }
    for (const [key, id] of Object.entries(sessions)) {
      if (!key) {
        continue; // defensive: the server rejects empty keys at ingest
      }
      let ids = idsByKey.get(key);
      if (!ids) {
        ids = new Set();
        idsByKey.set(key, ids);
      }
      // Canonicalize to string so a numeric id and its string form dedupe
      // rather than register as a conflict (ids are already strings when
      // received; this guards against runtime type violations).
      ids.add(String(id));
    }
  }

  // Keep only keys with a single distinct id across the batch.
  //
  // A key that disagrees on its id (e.g. a batch carrying conv_id:1 and
  // conv_id:2) is dropped entirely rather than resolved to one id, for
  // predictability.
  const keys: string[] = [];
  for (const [key, ids] of idsByKey) {
    if (ids.size === 1) {
      keys.push(key);
    }
  }

  // Deterministic `≤5`: sort by UTF-8 byte order (matching the server) and
  // take the first MAX_EVENT_SESSIONS keys.
  keys.sort(compareUtf8);

  const entries = keys
    .slice(0, MAX_EVENT_SESSIONS)
    .map((key): [string, string] => {
      const [id] = idsByKey.get(key)!;
      return [key, id as string];
    });

  // Object.fromEntries so keys like "__proto__" land as own properties.
  return Object.fromEntries(entries);
};
