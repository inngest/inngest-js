"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { streamRun } from "inngest/durable-endpoints";

export default function Home() {
  const [lines, setLines] = useState<string[]>([]);
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [waitingForInput, setWaitingForInput] = useState(false);

  const termRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (waitingForInput) {
      inputRef.current?.focus();
    }
  }, [waitingForInput]);

  const scrollToBottom = useCallback(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, []);

  async function handleSubmit() {
    setLines([]);
    setCorrelationId(null);
    setRunning(true);
    setWaitingForInput(false);

    try {
      await streamRun<string>("/api/demo", {
        parse: (d) => (typeof d === "string" ? d : JSON.stringify(d)),
        onData: (chunk) => {
          // Check for await-input signal
          try {
            const parsed = JSON.parse(chunk);
            if (parsed?.type === "await-input" && parsed?.correlationId) {
              setCorrelationId(parsed.correlationId);
              setWaitingForInput(true);
              return;
            }
          } catch {
            // Not JSON — treat as display text
          }

          setLines((prev) => [...prev, chunk]);
          scrollToBottom();
        },
        onResult: (data) => {
          const display =
            typeof data === "string" ? data : JSON.stringify(data);
          setLines((prev) => [...prev, display]);
          scrollToBottom();
        },
        onRollback: (count) => {
          setLines((prev) => prev.slice(0, prev.length - count));
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLines((prev) => [...prev, `[error] ${msg}`]);
    } finally {
      setRunning(false);
    }
  }

  async function handleDownload() {
    try {
      const text = lines.join("");
      const res = await fetch(
        `/api/download?text=${encodeURIComponent(text)}`,
      );

      if (!res.ok) {
        const body = await res.text();
        setLines((prev) => [...prev, `[download failed: ${body}]\n`]);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "transcript.txt";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLines((prev) => [...prev, `[download error] ${msg}\n`]);
    }
  }

  async function handleInput(value: string) {
    setWaitingForInput(false);
    const language = value.trim();
    setLines((prev) => [...prev, `> ${language}\n`]);

    if (language && correlationId) {
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, correlationId }),
      });
      if (!res.ok) {
        setLines((prev) => [...prev, "[request failed]\n"]);
      }
    }
  }

  let status = "";
  if (running) {
    status = "Running";
  } else if (correlationId) {
    status = "Done";
  }

  return (
    <main
      style={{
        padding: 32,
        fontFamily: "system-ui, sans-serif",
        maxWidth: 720,
        margin: "0 auto",
      }}
    >
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
        <button
          onClick={() => handleDownload()}
          disabled={running || lines.length === 0}
          style={{
            padding: "8px 20px",
            fontSize: 14,
            cursor: running || lines.length === 0 ? "not-allowed" : "pointer",
          }}
        >
          Download Transcript
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
          <span>{"\u00A0"}</span>
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
