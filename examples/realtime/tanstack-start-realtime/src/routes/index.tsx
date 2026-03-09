import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo, useCallback } from "react";
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

  const { status, runStatus, latest, history } = useRealtime({
    channel,
    topics,
    token: runId ? tokenFactory : undefined,
    enabled: !!runId,
  });

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
              status={status}
              runStatus={runStatus}
              latest={latest}
              history={history}
            />

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
