"use client";

import { useState, useRef } from "react";

interface SSECallbacks {
  onRunId: (runId: string) => void;
  onData: (display: string) => void;
  onScroll: () => void;
}

/**
 * Read an SSE stream from a Response, parsing events and calling callbacks.
 * Returns a redirect URL if a redirect event is received, or null if the
 * stream ends normally.
 */
async function readSSEStream(
  res: Response,
  callbacks: SSECallbacks,
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
      console.log(part);

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

      if (event === "inngest") {
        callbacks.onRunId((parsed as { run_id: string }).run_id);
      } else if (event === "stream" || event === "result") {
        const display =
          typeof parsed === "string" ? parsed : JSON.stringify(parsed);
        callbacks.onData(display);
      } else if (event === "redirect") {
        const redirectData = parsed as { url?: string };
        if (redirectData.url) {
          return redirectData.url;
        }
        // No URL in redirect — can't continue
        return null;
      }
    }

    callbacks.onScroll();
  }

  return null;
}

export default function Home() {
  const [endpoint, setEndpoint] = useState("/api/llm-approval");
  const [lines, setLines] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [debug, setDebug] = useState(false);
  const termRef = useRef<HTMLPreElement>(null);

  async function handleSubmit() {
    setLines([]);
    setRunId(null);
    setRunning(true);

    const callbacks: SSECallbacks = {
      onRunId: (id) => setRunId(id),
      onData: (display) => setLines((prev) => [...prev, display]),
      onScroll: () => {
        if (termRef.current) {
          termRef.current.scrollTop = termRef.current.scrollHeight;
        }
      },
    };

    try {
      // Initial request to the app endpoint
      const res = await fetch(endpoint, {
        headers: { Accept: "text/event-stream" },
      });

      if (!res.body) {
        setLines(["Error: no response body"]);
        setRunning(false);
        return;
      }

      const redirectUrl = await readSSEStream(res, callbacks);

      // If we got a redirect, connect to the checkpoint stream endpoint
      // on the Dev Server to continue receiving SSE data.
      if (redirectUrl) {
        if (debug) {
          setLines((prev) => [...prev, "[redirecting to async stream...]"]);
        }

        const asyncRes = await fetch(redirectUrl);
        if (!asyncRes.body) {
          setLines((prev) => [...prev, "[error] No body from async stream"]);
          return;
        }

        await readSSEStream(asyncRes, callbacks);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLines((prev) => [...prev, `[error] ${msg}`]);
    } finally {
      setRunning(false);
    }
  }

  async function handleApprove() {
    if (!runId) {
      return;
    }
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    if (!res.ok) {
      setLines((prev) => [...prev, `[approve failed: ${res.status}]`]);
    }
  }

  let status = "";
  if (runId && running) {
    status = "Running";
  } else if (runId && !running) {
    status = "Done";
  }

  let title = "";
  if (runId) {
    title = `Run: ${runId}`;
  }

  return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 16 }}>Durable Endpoint Stream</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <select
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          disabled={running}
          style={{ padding: "8px 12px", fontSize: 14 }}
        >
          <option value="/api/llm-approval">LLM approval</option>
          <option value="/api/stream">No steps</option>
          <option value="/api/stream-steps">With steps</option>
        </select>

        <select
          value={debug ? "on" : "off"}
          onChange={(e) => setDebug(e.target.value === "on")}
          style={{ padding: "8px 12px", fontSize: 14 }}
        >
          <option value="off">Debug: off</option>
          <option value="on">Debug: on</option>
        </select>

        <button
          onClick={handleSubmit}
          disabled={running}
          style={{
            padding: "8px 20px",
            fontSize: 14,
            cursor: running ? "not-allowed" : "pointer",
          }}
        >
          {running ? "Streaming..." : "Run"}
        </button>

        {endpoint === "/api/llm-approval" && runId && running && (
          <button
            onClick={handleApprove}
            style={{
              padding: "8px 20px",
              fontSize: 14,
              cursor: "pointer",
              background: "#16f090",
              color: "#1a1a2e",
              border: "none",
              borderRadius: 4,
              fontWeight: 600,
            }}
          >
            Approve
          </button>
        )}
      </div>

      <div
        style={{
          fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
          fontSize: 14,
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            background: "#16162a",
            color: "#888",
            padding: "8px 20px",
            borderBottom: "1px solid #2a2a4a",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>{title}</span>
          <span>{status}</span>
        </div>

        <pre
          ref={termRef}
          style={{
            background: "#1a1a2e",
            color: "#16f090",
            fontFamily: "inherit",
            fontSize: "inherit",
            lineHeight: 1.6,
            padding: 20,
            margin: 0,
            minHeight: 200,
            maxHeight: 500,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {lines.join("")}
        </pre>
      </div>
    </main>
  );
}
