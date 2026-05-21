/**
 * Event Store for polling-based progress updates
 *
 * Uses an in-memory store to avoid SSE timeout limits.
 * Clients poll for new events using a cursor-based approach.
 */

export type ProgressEvent = {
  type:
    | "step-start"
    | "step-progress"
    | "step-complete"
    | "step-error"
    | "step-retry"
    | "complete";
  stepId?: string;
  message?: string;
  result?: unknown;
  error?: string;
  retryCount?: number;
  timestamp: string;
};

type EventStore = {
  events: Array<ProgressEvent & { seq: number }>;
  nextSeq: number;
  createdAt: number;
  status: "running" | "complete" | "error";
};

// Store for booking events (bookingId -> EventStore)
const eventStores = new Map<string, EventStore>();

// Cleanup old event stores after 30 minutes
const EVENT_STORE_TTL = 30 * 60 * 1000;

function cleanupOldEventStores() {
  const now = Date.now();
  for (const [bookingId, store] of eventStores.entries()) {
    if (now - store.createdAt > EVENT_STORE_TTL) {
      eventStores.delete(bookingId);
    }
  }
}

// Run cleanup every 5 minutes
if (typeof setInterval !== "undefined") {
  setInterval(cleanupOldEventStores, 5 * 60 * 1000);
}

/**
 * Get or create an event store for a booking session
 */
function getEventStore(bookingId: string): EventStore {
  let store = eventStores.get(bookingId);
  if (!store) {
    store = {
      events: [],
      nextSeq: 0,
      createdAt: Date.now(),
      status: "running",
    };
    eventStores.set(bookingId, store);
  }
  return store;
}

/**
 * Emit a progress event for a booking session
 */
export function emitProgress(
  bookingId: string,
  event: Omit<ProgressEvent, "timestamp">
) {
  const store = getEventStore(bookingId);
  const fullEvent: ProgressEvent & { seq: number } = {
    ...event,
    timestamp: new Date().toISOString(),
    seq: store.nextSeq++,
  };
  store.events.push(fullEvent);

  if (event.type === "complete") {
    store.status = "complete";
  } else if (event.type === "step-error" && !event.retryCount) {
    store.status = "error";
  }
}

/**
 * Get events since a cursor for a booking session
 */
export function getEventsSinceCursor(bookingId: string, cursor: number) {
  const store = eventStores.get(bookingId);
  if (!store) {
    return null;
  }

  return {
    events: store.events.filter((e) => e.seq >= cursor),
    cursor: store.nextSeq,
    status: store.status,
  };
}
