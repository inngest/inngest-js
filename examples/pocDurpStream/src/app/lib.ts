export interface StreamCallbacks {
  onRunId: (runId: string) => void;
  onData: (display: string) => void;
  onScroll: () => void;
}

/**
 * Parse an SSE stream, calling callbacks for each event.
 * Returns a redirect URL if received, or null.
 */
async function readSSEStream(
  res: Response,
  callbacks: StreamCallbacks
): Promise<string | null> {
  if (!res.body) {
    return null;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    // Keep the last part as the buffer — it may be incomplete
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      if (!part.trim()) {
        continue;
      }

      let event = "message";
      let data = "";

      for (const line of part.split("\n")) {
        if (line.startsWith("event: ")) {
          event = line.slice(7);
        } else if (line.startsWith("data: ")) {
          data = line.slice(6);
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = data;
      }

      console.log("[sse]", event, parsed);

      if (event === "inngest") {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.run_id === "string") {
          callbacks.onRunId(obj.run_id);
        }
      } else if (event === "stream" || event === "result") {
        const display =
          typeof parsed === "string" ? parsed : JSON.stringify(parsed);
        callbacks.onData(display);
      } else if (event === "redirect") {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.url === "string") {
          return obj.url;
        }
        return null;
      }
    }

    callbacks.onScroll();
  }

  return null;
}

/**
 * Start an SSE stream against the given endpoint, following redirects
 * to the realtime SSE endpoint if the function goes async.
 */
export async function startStream(
  endpoint: string,
  callbacks: StreamCallbacks
): Promise<void> {
  let capturedRunId: string | null = null;

  const wrappedCallbacks: StreamCallbacks = {
    ...callbacks,
    onRunId: (runId: string) => {
      capturedRunId = runId;
      callbacks.onRunId(runId);
    },
  };

  const res = await fetch(endpoint, {
    headers: { Accept: "text/event-stream" },
  });

  if (!res.body) {
    throw new Error("No response body");
  }

  const redirectUrl = await readSSEStream(res, wrappedCallbacks);

  if (redirectUrl && capturedRunId) {
    // Get a realtime JWT for this run
    const tokenRes = await fetch(
      `/api/stream-token?runId=${encodeURIComponent(capturedRunId)}`
    );
    if (!tokenRes.ok) {
      throw new Error("Failed to get realtime token");
    }
    const { token } = await tokenRes.json();

    // Connect to the dev server's realtime SSE endpoint
    const realtimeUrl = `http://localhost:8288/v1/realtime/sse?token=${encodeURIComponent(token)}`;
    const asyncRes = await fetch(realtimeUrl);
    if (!asyncRes.body) {
      throw new Error("No body from realtime stream");
    }

    await readSSEStream(asyncRes, callbacks);
  }
}

/**
 * Send human-in-the-loop input back to the running function.
 */
export async function sendInput(
  runId: string,
  language: string
): Promise<boolean> {
  const res = await fetch("/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language, runId }),
  });
  return res.ok;
}
