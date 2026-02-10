/**
 * Event Store for polling-based progress updates
 *
 * Uses an in-memory store to avoid SSE timeout limits.
 * Clients poll for new events using a cursor-based approach.
 */

import type { ResearchEvent } from "./types";

type EventStore = {
  events: Array<ResearchEvent & { seq: number }>;
  nextSeq: number;
  createdAt: number;
  status: "running" | "complete" | "error";
};

// Store for research events (researchId -> EventStore)
const eventStores = new Map<string, EventStore>();

// Cleanup old event stores after 30 minutes
const EVENT_STORE_TTL = 30 * 60 * 1000;

function cleanupOldEventStores() {
  const now = Date.now();
  for (const [researchId, store] of eventStores.entries()) {
    if (now - store.createdAt > EVENT_STORE_TTL) {
      eventStores.delete(researchId);
    }
  }
}

// Run cleanup every 5 minutes
if (typeof setInterval !== "undefined") {
  setInterval(cleanupOldEventStores, 5 * 60 * 1000);
}

/**
 * Get or create an event store for a research session
 */
export function getEventStore(researchId: string): EventStore {
  let store = eventStores.get(researchId);
  if (!store) {
    store = {
      events: [],
      nextSeq: 0,
      createdAt: Date.now(),
      status: "running",
    };
    eventStores.set(researchId, store);
  }
  return store;
}

/**
 * Emit a progress event for a research session
 * Events are stored for polling by the client
 */
export function emitProgress(
  researchId: string,
  event: Omit<ResearchEvent, "timestamp">
) {
  const store = getEventStore(researchId);
  const fullEvent = {
    ...event,
    timestamp: new Date().toISOString(),
    seq: store.nextSeq++,
  };
  store.events.push(fullEvent);

  // Update status on completion or error
  if (event.type === "complete") {
    store.status = "complete";
  } else if (event.type === "error") {
    store.status = "error";
  }
}

/**
 * Get events since a cursor for a research session
 * Returns null if the session doesn't exist
 */
export function getEventsSinceCursor(researchId: string, cursor: number) {
  const store = eventStores.get(researchId);
  if (!store) {
    return null;
  }

  return {
    events: store.events.filter((e) => e.seq >= cursor),
    cursor: store.nextSeq,
    status: store.status,
  };
}
