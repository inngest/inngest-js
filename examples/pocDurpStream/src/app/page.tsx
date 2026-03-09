"use client";

import { useState, useRef, useEffect } from "react";
import { RunStream } from "inngest/durable-endpoints";

async function sendInput(runId: string, language: string): Promise<boolean> {
  const res = await fetch("/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language, runId }),
  });
  return res.ok;
}

export default function Home() {
  const [lines, setLines] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [waitingForInput, setWaitingForInput] = useState(false);
  const [retryInfo, setRetryInfo] = useState<{
    stepId: string;
    attempt: number;
  } | null>(null);

  const termRef = useRef<HTMLPreElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (waitingForInput) {
      inputRef.current?.focus();
    }
  }, [waitingForInput]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function handleSubmit() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLines([]);
    setRunId(null);
    setRunning(true);
    setWaitingForInput(false);
    setRetryInfo(null);

    try {
      const run = new RunStream<string>("/api/demo", {
        signal: controller.signal,
      });
      await run
        .onConnected((runId) => setRunId(runId))
        .onData((chunk) => {
          setLines((prev) => [...prev, String(chunk)]);
          if (
            typeof chunk === "string" &&
            chunk.includes("What language should I translate to?")
          ) {
            setWaitingForInput(true);
          }
          if (termRef.current) {
            termRef.current.scrollTop = termRef.current.scrollHeight;
          }
        })
        .onRollback((removed, _chunks, stepId, attempt) => {
          setLines((prev) => prev.slice(0, -removed.length));
          setRetryInfo({ stepId, attempt });
        })
        .onStepStarted(() => setRetryInfo(null))
        .start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLines((prev) => [...prev, `[error] ${msg}`]);
    } finally {
      setRunning(false);
    }
  }

  async function handleInput(value: string) {
    setWaitingForInput(false);
    const language = value.trim();
    setLines((prev) => [...prev, `> ${language}\n`]);

    if (language && runId) {
      const ok = await sendInput(runId, language);
      if (!ok) {
        setLines((prev) => [...prev, "[request failed]\n"]);
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
          {retryInfo !== null && (
            <span style={{ color: "#f0a030" }}>
              {`\n! Step "${retryInfo.stepId}" failed — retrying (attempt ${retryInfo.attempt})…\n`}
            </span>
          )}
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
