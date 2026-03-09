import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, useCallback, useEffect } from "react";
import { useRealtime } from "inngest/react";
import { contentPipeline } from "../inngest/channels";
import { getToken, startPipeline } from "../utils/pipeline";
import { GenerateForm } from "../components/GenerateForm";
import { Pipeline } from "../components/Pipeline";

const topics = ["status", "tokens", "artifact"] as const;

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const [runId, setRunId] = useState<string | null>(null);

  const channel = useMemo(
    () => (runId ? contentPipeline({ runId }) : undefined),
    [runId],
  );

  const tokenFactory = useCallback(
    () => getToken({ data: { runId: runId! } }),
    [runId],
  );

  // ---------------------------------------------------------------------------
  // Destructure ALL return values from useRealtime.
  //
  // The hook is parameterized by the channel type, so every field carries
  // per-topic typing automatically — no `as` casts needed anywhere.
  // ---------------------------------------------------------------------------
  const {
    connectionStatus,
    runStatus,
    isPaused,
    pauseReason,
    messages,
    result,
    error,
    reset,
  } = useRealtime({
    channel,
    topics,
    token: runId ? tokenFactory : undefined,
    enabled: !!runId,
  });

  // ---------------------------------------------------------------------------
  // Debug logging — demonstrates how to work with the typed return values.
  // ---------------------------------------------------------------------------
  const { byTopic, all, last, delta } = messages;

  useEffect(() => {
    // -------------------------------------------------------------------------
    // 1. Per-topic typed access via `messages.byTopic`
    //
    //    Each topic on `messages.byTopic` is fully typed. No casts, no `as`, just
    //    dot-access and the data shape matches the channel's schema.
    // -------------------------------------------------------------------------
    if (byTopic.status) {
      // byTopic.status.data is { message: string; step?: string }
      console.log("[messages.byTopic.status]", {
        message: byTopic.status.data.message, // string
        step: byTopic.status.data.step, // string | undefined
        topic: byTopic.status.topic, // "status" (literal)
        kind: byTopic.status.kind, // "data" | "datastream-start" | ...
      });
    }

    if (byTopic.tokens) {
      // byTopic.tokens.data is { token: string; step: string }
      console.log("[messages.byTopic.tokens]", {
        token: byTopic.tokens.data.token, // string
        step: byTopic.tokens.data.step, // string
      });
    }

    if (byTopic.artifact) {
      // byTopic.artifact.data is { kind: "research"|"outline"|"draft"; title: string; body: string }
      console.log("[messages.byTopic.artifact]", {
        kind: byTopic.artifact.data.kind, // "research" | "outline" | "draft"
        title: byTopic.artifact.data.title, // string
        bodyPreview: byTopic.artifact.data.body.slice(0, 80), // string
      });

      // -----------------------------------------------------------------------
      // 2. Discriminated union narrowing on artifact.data.kind
      //
      //    Since `kind` is a string enum, you can switch on it and TypeScript
      //    narrows the type in each branch. Useful when different kinds have
      //    different rendering logic.
      // -----------------------------------------------------------------------
      switch (byTopic.artifact.data.kind) {
        case "research":
          console.log("[artifact:research] notes:", byTopic.artifact.data.body);
          break;
        case "outline":
          console.log("[artifact:outline] sections:", byTopic.artifact.data.body);
          break;
        case "draft":
          console.log("[artifact:draft] full post:", byTopic.artifact.data.body);
          break;
      }
    }
  }, [byTopic.status, byTopic.tokens, byTopic.artifact]);

  useEffect(() => {
    // -------------------------------------------------------------------------
    // 3. Discriminated union narrowing on `messages.delta` items
    //
    //    Each message entry is a union discriminated by `topic`. Narrowing
    //    with `msg.topic === "status"` gives you the correctly typed `data`.
    // -------------------------------------------------------------------------
    for (const msg of delta) {
      if (msg.kind === "run") {
        // Run lifecycle message — data is untyped (platform-internal)
        console.log("[messages.delta:run]", msg.data);
        continue;
      }

      // Narrow by topic to get per-topic data typing
      switch (msg.topic) {
        case "status":
          // msg.data is { message: string; step?: string }
          console.log(
            "[messages.delta:status]",
            msg.data.message,
            msg.data.step,
          );
          break;
        case "tokens":
          // msg.data is { token: string; step: string }
          console.log("[messages.delta:tokens]", msg.data.token);
          break;
        case "artifact":
          // msg.data is { kind: "research"|"outline"|"draft"; title: string; body: string }
          console.log("[messages.delta:artifact]", msg.data.kind, msg.data.title);
          break;
      }
    }
  }, [delta]);

  useEffect(() => {
    if (!last || last.kind === "run") return;

    if (last.topic === "status") {
      console.log("[messages.last → status]", last.data.message);
    } else if (last.topic === "tokens") {
      console.log("[messages.last → tokens]", last.data.token);
    } else if (last.topic === "artifact") {
      console.log(
        "[messages.last → artifact]",
        last.data.kind,
        last.data.title,
      );
    }
  }, [last]);

  useEffect(() => {
    // -------------------------------------------------------------------------
    // 5. Connection status, run status, error, and result
    // -------------------------------------------------------------------------
    console.log("[connectionStatus]", connectionStatus);
    console.log("[runStatus]", runStatus);
    console.log("[isPaused]", isPaused);
    console.log("[pauseReason]", pauseReason);
    console.log("[error]", error?.message ?? null);
    console.log("[messages.all.length]", all.length);
    console.log("[messages.delta.length]", delta.length);
  }, [connectionStatus, runStatus, isPaused, pauseReason, error, all.length, delta.length]);

  useEffect(() => {
    // -------------------------------------------------------------------------
    // 6. Run result — available when runStatus === "completed"
    //
    //    The result is the Inngest function's return value. It's typed as
    //    `unknown` since the hook doesn't know the function's return type.
    //    Narrow it yourself based on your function's contract.
    // -------------------------------------------------------------------------
    if (runStatus === "completed" && result !== undefined) {
      const typedResult = result as { draft: string };
      console.log("[result]", typedResult.draft?.slice(0, 100));
    }
  }, [runStatus, result]);

  const isRunning =
    !!runId &&
    runStatus !== "completed" &&
    runStatus !== "failed" &&
    runStatus !== "cancelled";

  const handleSubmit = async (topic: string) => {
    const { runId: newRunId } = await startPipeline({ data: { topic } });
    setRunId(newRunId);
  };

  const handleReset = () => {
    reset();
    setRunId(null);
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          AI Blog Post Generator
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Enter a topic and watch Inngest orchestrate a multi-step AI pipeline
          with realtime updates.
        </p>
      </header>

      <div className="space-y-8">
        <GenerateForm onSubmit={handleSubmit} disabled={isRunning} />

        {runId && (
          <>
            <Pipeline
              key={runId}
              connectionStatus={connectionStatus}
              runStatus={runStatus}
              messagesByTopic={byTopic}
            />

            {error && (
              <div className="rounded bg-red-50 p-3 text-sm text-red-700">
                {error.message}
              </div>
            )}

            {!isRunning && (
              <button
                onClick={handleReset}
                className="text-sm text-indigo-600 hover:text-indigo-800 underline"
              >
                Start a new generation
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
