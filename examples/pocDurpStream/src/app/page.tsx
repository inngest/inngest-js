"use client";

import { useState, useRef, useEffect } from "react";

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
  callbacks: SSECallbacks
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
  const endpoint = "/api/demo";
  const [lines, setLines] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const [waitingForInput, setWaitingForInput] = useState(false);
  const termRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (waitingForInput) {
      inputRef.current?.focus();
    }
  }, [waitingForInput]);

  async function handleSubmit() {
    setLines([]);
    setRunId(null);
    setRunning(true);
    setWaitingForInput(false);

    const callbacks: SSECallbacks = {
      onRunId: (id) => setRunId(id),
      onData: (display) => {
        setLines((prev) => [...prev, display]);
        if (display.includes("Do you want to continue?")) {
          setWaitingForInput(true);
        }
      },
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
      console.log(new Date().toISOString(), "fetch: redirectUrl", redirectUrl);

      // If we got a redirect, connect to the checkpoint stream endpoint
      // on the Dev Server to continue receiving SSE data.
      if (redirectUrl) {
        // await new Promise((resolve) => setTimeout(resolve, 10000));
        console.log(new Date().toISOString(), "fetch: before", redirectUrl);
        // @ts-expect-error duplex not in RequestInit types yet
        const asyncRes = await fetch(redirectUrl, { duplex: "half" });
        console.log(new Date().toISOString(), "fetch: after");
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

  async function handleInput(value: string) {
    setWaitingForInput(false);
    const input = value.trim().toLowerCase();
    setLines((prev) => [...prev, `> ${value}\n`]);

    if ((input === "y" || input === "n") && runId) {
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: input === "y", runId }),
      });
      if (!res.ok) {
        setLines((prev) => [...prev, `[approve failed: ${res.status}]\n`]);
      }
    }
  }

  let status = "";
  if (runId && running) {
    status = "Running";
  } else if (runId && !running) {
    status = "Done";
  }

  let title = "\u00A0";
  if (runId) {
    title = `Run: ${runId}`;
  }

  return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 16 }}>Durp streaming POC</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
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
          {waitingForInput && (
            <span>
              {"$ "}
              <input
                ref={inputRef}
                type="text"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleInput(e.currentTarget.value);
                    e.currentTarget.value = "";
                  }
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "inherit",
                  font: "inherit",
                  width: "80%",
                  padding: 0,
                  margin: 0,
                }}
              />
            </span>
          )}
        </pre>
      </div>
    </main>
  );
}
