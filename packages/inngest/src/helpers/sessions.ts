import type {
  EventMeta,
  EventSessions,
  PropagatedEventSessions,
  ReceivedEventMeta,
} from "../types.ts";

/**
 * A normalized session layer as carried on the wire. Values are session-id
 * strings; `null` is a per-key tombstone (RFC 7386) preserved so the server can
 * cut the matching inherited session. Only the manual layer admits tombstones.
 */
type NormalizedSessions = Record<string, string | null>;

/**
 * Validates event sessions and normalizes their values to strings, matching the
 * shape stored by the Inngest server. Shared by the two layer-specific entry
 * points below; `layer` selects how `null` is treated.
 *
 * Returns `undefined` if no sessions were given (an absent field, or an empty
 * object — an empty RFC 7386 patch leaves the inherited layer untouched);
 * returns `null` for a preserved "clear all" tombstone.
 */
const normalizeSessions = (
  sessions: EventSessions | null | undefined,
  layer: "manual" | "propagated",
): NormalizedSessions | null | undefined => {
  const allowCut = layer === "manual";

  if (sessions === undefined) {
    return undefined;
  }
  if (sessions === null) {
    // Whole-field null: on the manual layer this is the "clear all inherited"
    // tombstone, preserved on the wire; on the propagated layer it is a no-op.
    return allowCut ? null : undefined;
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
  const normalized: [string, string | null][] = [];
  for (const [key, value] of entries) {
    if (!key) {
      throw new Error("Event session keys cannot be empty");
    }
    if (value === null) {
      if (!allowCut) {
        throw new Error(`Event session "${key}" must be a string or number`);
      }
      // Per-key tombstone: preserved on the wire, consumed server-side.
      normalized.push([key, null]);
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(
        allowCut
          ? `Event session "${key}" must be a string, number, or null`
          : `Event session "${key}" must be a string or number`,
      );
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

/**
 * Normalizes the manual `meta.sessions` layer, which is user-authored and so
 * admits RFC 7386 tombstones: a `null` value is preserved as a per-key cut of
 * the inherited session, and a whole-field `null` is preserved (as `null`) to
 * mean "clear all inherited sessions". Tombstones are consumed server-side and
 * never count against the per-event session limit.
 */
export const normalizeManualSessions = (
  sessions: EventSessions | null | undefined,
): NormalizedSessions | null | undefined =>
  normalizeSessions(sessions, "manual");

/**
 * Normalizes the `meta.propagated_sessions` layer, which is machine-stamped from
 * `ctx.sessions` and carries no tombstones — so `null` values are rejected and a
 * whole-field `null` is dropped. The layer is typed `@internal`, but a hand-set
 * value can still reach here (a direct `inngest.send()` is never stamped, and
 * `step.sendEvent` leaves the payload untouched when there is nothing to
 * propagate), so the rejection is a real trust boundary rather than a
 * formality.
 */
export const normalizePropagatedSessions = (
  sessions: PropagatedEventSessions | null | undefined,
): Record<string, string> | undefined =>
  // The "propagated" layer never returns tombstones, so narrow the value type.
  normalizeSessions(sessions, "propagated") as
    | Record<string, string>
    | undefined;

export const normalizeEventMeta = (
  meta: EventMeta | null | undefined,
): NormalizedEventMeta | undefined => {
  if (meta === undefined || meta === null) {
    return undefined;
  }
  if (typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("Event meta must be an object");
  }

  const sessions = normalizeManualSessions(meta.sessions);
  const propagatedSessions = normalizePropagatedSessions(
    meta.propagated_sessions,
  );
  if (sessions === undefined && propagatedSessions === undefined) {
    return undefined;
  }

  const out: NormalizedEventMeta = {};
  // `sessions` may be `null` (whole-field "clear all inherited" tombstone),
  // which must survive on the wire — so distinguish it from `undefined`.
  if (sessions !== undefined) {
    out.sessions = sessions;
  }
  if (propagatedSessions !== undefined) {
    out.propagated_sessions = propagatedSessions;
  }

  return out;
};

type NormalizedEventMeta = {
  sessions?: NormalizedSessions | null;
  propagated_sessions?: Record<string, string>;
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
  // A run's triggering events are received events, so this takes the received
  // shape: session ids are already strings, and tombstones have been consumed
  // server-side.
  events: ReadonlyArray<{ meta?: ReceivedEventMeta | null }>,
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
      // These events come off the executor's request body, so the received
      // invariants (non-empty keys, string ids, tombstones already consumed)
      // are the server's promise rather than something the type system
      // enforces here. Each guard below defends that boundary, and each one
      // prevents a *silent* wrong answer rather than a loud failure:
      //
      // - an empty key is rejected at ingest, so it should never appear;
      // - a `null` id is a tombstone the server should already have consumed,
      //   and `String(null)` would propagate the literal id `"null"`;
      // - a numeric id would make `1` and `"1"` dedupe as two distinct ids,
      //   dropping the key below as a false conflict.
      if (!key) {
        continue;
      }
      if (id === null || id === undefined) {
        continue;
      }
      let ids = idsByKey.get(key);
      if (!ids) {
        ids = new Set();
        idsByKey.set(key, ids);
      }
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
