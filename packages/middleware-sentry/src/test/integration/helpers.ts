import {
  createTransport,
  ServerRuntimeClient,
  setCurrentClient,
} from "@sentry/core";
import type { InternalBaseTransportOptions, Transport } from "@sentry/types";

export interface CapturedItem {
  type: string;
  payload: Record<string, unknown>;
}

export interface Captured {
  items: CapturedItem[];
}

/**
 * Parse a Sentry envelope body (newline-delimited JSON) into individual items.
 *
 * Format:
 *   Line 0 — envelope header
 *   Line 1 — item header  (has `type`)
 *   Line 2 — item payload
 *   ...
 */
function parseEnvelope(body: string | Uint8Array): CapturedItem[] {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  const lines = text.split("\n").filter(Boolean);
  const items: CapturedItem[] = [];

  // Skip line 0 (envelope header). Items start at index 1.
  for (let i = 1; i < lines.length - 1; i += 2) {
    try {
      const header = JSON.parse(lines[i]!) as Record<string, unknown>;
      const payload = JSON.parse(lines[i + 1]!) as Record<string, unknown>;
      if (typeof header.type === "string") {
        items.push({ type: header.type, payload });
      }
    } catch {
      // Malformed pair — skip.
    }
  }
  return items;
}

/**
 * Initializes Sentry via @sentry/core's low-level API.
 *
 * We use @sentry/core directly (not @sentry/node) because the middleware
 * imports from @sentry/core. pnpm isolates them as separate module instances
 * so only @sentry/core's global state is visible to the middleware.
 */
export function initSentryCapture(): Captured {
  const captured: Captured = { items: [] };

  const makeTransport = (opts: InternalBaseTransportOptions): Transport =>
    createTransport(opts, async (request) => {
      captured.items.push(...parseEnvelope(request.body));
      return { statusCode: 200 };
    });

  const client = new ServerRuntimeClient({
    dsn: "https://examplePublicKey@o0.ingest.sentry.io/0",
    tracesSampleRate: 1.0,
    integrations: [],
    stackParser: () => [],
    transport: makeTransport,
  });

  setCurrentClient(client);
  client.init();

  return captured;
}

export function capturedErrors(c: Captured): CapturedItem[] {
  return c.items.filter((i) => i.type === "event");
}

export function capturedTransactions(c: Captured): CapturedItem[] {
  return c.items.filter((i) => i.type === "transaction");
}

/** Check whether a captured error item contains an exception with the given message. */
export function errorHasException(
  item: CapturedItem,
  message: string,
): boolean {
  const exc = item.payload.exception;
  if (typeof exc !== "object" || exc === null) {
    return false;
  }
  const values = (exc as Record<string, unknown>).values;
  if (!Array.isArray(values)) {
    return false;
  }
  return values.some(
    (v: unknown) =>
      typeof v === "object" &&
      v !== null &&
      (v as Record<string, unknown>).value === message,
  );
}

/** Filter captured errors to only step-level errors (tagged by the middleware). */
export function capturedStepErrors(c: Captured): CapturedItem[] {
  return capturedErrors(c).filter((item) => {
    const tags = item.payload.tags as Record<string, string> | undefined;
    return tags?.["inngest.error.source"] === "step";
  });
}

/** Collect all span descriptions across captured transactions. */
export function collectSpanNames(c: Captured): string[] {
  const names: string[] = [];
  for (const tx of capturedTransactions(c)) {
    const spans = tx.payload.spans as
      | Array<{ description?: string }>
      | undefined;
    if (spans) {
      for (const span of spans) {
        if (span.description) {
          names.push(span.description);
        }
      }
    }
  }
  return names;
}
