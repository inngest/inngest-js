"use client";

import { useState, useRef } from "react";

export default function Home() {
  const [lines, setLines] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const termRef = useRef<HTMLPreElement>(null);

  async function handleSubmit() {
    setLines([]);
    setRunId(null);
    setRunning(true);

    try {
      const res = await fetch("/api/stream", {
        headers: { Accept: "text/event-stream" },
      });

      if (!res.body) {
        setLines(["Error: no response body"]);
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }

        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        // Keep the last part as the buffer — it may be incomplete
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          if (!part.trim()) { continue; }

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
            setRunId((parsed as { run_id: string }).run_id);
          } else if (event === "stream" || event === "result") {
            const display = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
            setLines((prev) => [...prev, display]);
          }
        }

        // Auto-scroll
        if (termRef.current) {
          termRef.current.scrollTop = termRef.current.scrollHeight;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLines((prev) => [...prev, `[error] ${msg}`]);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 16 }}>Durable Endpoint Stream</h1>

      <button
        onClick={handleSubmit}
        disabled={running}
        style={{
          padding: "8px 20px",
          fontSize: 14,
          cursor: running ? "not-allowed" : "pointer",
          marginBottom: 16,
        }}
      >
        {running ? "Streaming..." : "Run"}
      </button>

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
          }}
        >
          {runId ?? "\u00A0"}
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
          {lines.map((line, i) => <div key={i}>{line}</div>)}
        </pre>
      </div>
    </main>
  );
}
