import type { EventSessions } from "../types.ts";

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
