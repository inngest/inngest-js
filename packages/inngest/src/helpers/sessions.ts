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

  const normalized: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!name) {
      throw new Error("Event session names cannot be empty");
    }
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new Error(
        `Event session "${name}" must be a string, number, or boolean`,
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Event session "${name}" must be a finite number`);
    }

    const id = String(value);
    if (!id) {
      throw new Error(`Event session "${name}" cannot have an empty ID`);
    }

    normalized[name] = id;
  }

  return normalized;
};
