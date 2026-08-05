import type {
  EventMeta,
  EventSessions,
  PropagatedEventSessions,
} from "../types.ts";
import type { SendEventPayload } from "./types.ts";

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
 * Collects one event's sessions into a Map, which (unlike a plain object)
 * sidesteps `__proto__`/prototype-key footguns.
 */
const ownSessions = (
  sessions: EventMeta["sessions"] | undefined,
): Map<string, string> => {
  const own = new Map<string, string>();
  if (!sessions) {
    return own;
  }

  for (const [key, id] of Object.entries(sessions)) {
    if (!key) {
      continue; // defensive: the server rejects empty keys at ingest
    }
    if (id === null) {
      // A run's triggering events are already-resolved (received) events, so
      // their sessions never hold tombstones; guard defensively since the
      // send-time EventSessionValue type now admits null.
      continue;
    }
    // Canonicalize to string so a numeric id and its string form match rather
    // than diverge (ids are already strings when received; this guards against
    // runtime type violations).
    own.set(key, String(id));
  }

  return own;
};

/**
 * Reduces a run's triggering events to the deterministic set of sessions that
 * become the propagated sessions: the intersection of every triggering event's
 * `(key, id)` pairs.
 *
 * A key must be present with the same id on *all* the events to survive, so a
 * key missing from any one event — or disagreeing on its id — is dropped. The
 * server caps a single event at `MAX_EVENT_SESSIONS`, which bounds the
 * intersection at that too; the truncation below is a backstop for an event
 * that somehow arrives over the cap.
 */
export const reduceEventsToPropagatedSessions = (
  // Accepts the send-time EventMeta shape (numeric ids permitted) since that is
  // how a run's triggering events are statically typed; ids are canonicalized
  // to strings below, so received string ids pass through unchanged.
  events: ReadonlyArray<{ meta?: EventMeta | null }>,
): Record<string, string> => {
  // Seed from the first event, then narrow against each of the rest.
  let shared: Map<string, string> | undefined;
  for (const event of events) {
    const own = ownSessions(event?.meta?.sessions);
    if (!shared) {
      shared = own;
    } else {
      // Deleting during iteration is well-defined: entries removed before they
      // are reached are not visited.
      for (const [key, id] of shared) {
        if (own.get(key) !== id) {
          shared.delete(key);
        }
      }
    }
    if (shared.size === 0) {
      break;
    }
  }

  if (!shared || shared.size === 0) {
    return {};
  }

  // Deterministic `≤5`: sort by UTF-8 byte order (matching the server) and
  // take the first MAX_EVENT_SESSIONS keys.
  const entries = [...shared.entries()]
    .sort(([a], [b]) => compareUtf8(a, b))
    .slice(0, MAX_EVENT_SESSIONS);

  // Object.fromEntries so keys like "__proto__" land as own properties.
  return Object.fromEntries(entries);
};

/**
 * Stamps `sessions` onto a single outgoing payload as the
 * `meta.propagated_sessions` layer, so child runs stay grouped in the parent's
 * sessions. The manual `meta.sessions` layer is left untouched — the server
 * merges the two (manual wins per key).
 *
 * Shared by every propagation entry point (`step.sendEvent`, `step.invoke`, and
 * a bare `inngest.send()` inside a run) so their stamping can't drift.
 *
 * `sessions` is read at stamp time so a run-level override (mutating
 * `ctx.sessions` in the handler) is reflected. When there is nothing to
 * propagate the payload is returned unchanged.
 *
 * Pass `onlyIfAbsent` when stamping *downstream* of another entry point, to
 * leave the upstream stamp authoritative rather than clobbering it.
 */
export const stampPropagatedSessionsOnEvent = <T extends { meta?: EventMeta }>(
  payload: T,
  sessions: Record<string, string> | undefined,
  { onlyIfAbsent = false }: { onlyIfAbsent?: boolean } = {},
): T => {
  if (!sessions || Object.keys(sessions).length === 0) {
    return payload;
  }

  if (onlyIfAbsent && payload.meta?.propagated_sessions !== undefined) {
    return payload;
  }

  return {
    ...payload,
    meta: {
      ...payload.meta,

      // Clone so that mutating one event's sessions in middleware doesn't
      // inadvertently mutate every other event's sessions, or `ctx.sessions`
      // itself.
      propagated_sessions: { ...sessions },
    },
  };
};

/**
 * {@link stampPropagatedSessionsOnEvent} over a `step.sendEvent` payload, which
 * may be a single event or an array.
 */
export const stampPropagatedSessions = (
  payload: SendEventPayload,
  sessions: Record<string, string> | undefined,
): SendEventPayload =>
  Array.isArray(payload)
    ? payload.map((p) => stampPropagatedSessionsOnEvent(p, sessions))
    : stampPropagatedSessionsOnEvent(payload, sessions);
