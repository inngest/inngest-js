import { useMemo } from "react";
import type {
  UseRealtimeConnectionStatus,
  UseRealtimeRunStatus,
} from "inngest/react";
import type { Realtime } from "inngest/realtime";
import { StatusBadge } from "./StatusBadge";

interface PipelineProps {
  status: UseRealtimeConnectionStatus;
  runStatus: UseRealtimeRunStatus;
  latest: Record<string, Realtime.Message | undefined>;
  history: Realtime.Message[];
}

const stepOrder = ["research", "outline", "draft"] as const;

export function Pipeline({ status, runStatus, latest, history }: PipelineProps) {
  const currentStatus = latest.status?.data as
    | { message: string; step?: string }
    | undefined;

  const artifacts = useMemo(
    () =>
      history.filter(
        (msg): msg is Realtime.Message & { data: { kind: string; title: string; body: string } } =>
          msg.topic === "artifact" && msg.kind === "data"
      ),
    [history]
  );

  //
  // Accumulate tokens from all token messages in history
  const draftPreview = useMemo(() => {
    return history
      .filter((msg) => msg.topic === "tokens" && msg.kind === "data")
      .map((msg) => (msg.data as { token: string }).token)
      .join("");
  }, [history]);

  const isActive = status === "open" || status === "connecting";
  const isDone = runStatus === "completed" || runStatus === "failed" || runStatus === "cancelled";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <StatusBadge status={status} runStatus={runStatus} />
        {currentStatus && isActive && (
          <span className="text-sm font-medium text-indigo-600 animate-pulse">
            {currentStatus.message}
          </span>
        )}
        {isDone && !currentStatus && (
          <span className="text-sm text-gray-500">Pipeline complete</span>
        )}
      </div>

      {/* Step progress indicators */}
      <div className="flex gap-2">
        {stepOrder.map((step) => {
          const isCurrentStep = currentStatus?.step === step;
          const isPast =
            currentStatus?.step &&
            stepOrder.indexOf(currentStatus.step as (typeof stepOrder)[number]) >
              stepOrder.indexOf(step);
          const hasArtifact = artifacts.some(
            (a) => a.data.kind === step
          );

          let bg = "bg-gray-200 text-gray-500";
          if (hasArtifact || isPast) bg = "bg-green-100 text-green-700";
          else if (isCurrentStep) bg = "bg-indigo-100 text-indigo-700";

          return (
            <span
              key={step}
              className={`rounded-full px-3 py-1 text-xs font-medium capitalize ${bg}`}
            >
              {step}
              {isCurrentStep && !hasArtifact && (
                <span className="ml-1 animate-pulse">...</span>
              )}
            </span>
          );
        })}
      </div>

      {/* Artifacts */}
      {artifacts.length > 0 && (
        <div className="space-y-4">
          {artifacts.map((artifact, i) => (
            <details
              key={i}
              open={artifact.data.kind === "draft"}
              className="group rounded-lg border border-gray-200 bg-white"
            >
              <summary className="flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50">
                <span className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
                  {artifact.data.title}
                </span>
                <span className="text-xs text-gray-400 capitalize">
                  {artifact.data.kind}
                </span>
              </summary>
              <div className="border-t border-gray-100 px-4 py-3">
                <pre className="whitespace-pre-wrap text-sm text-gray-600 leading-relaxed">
                  {artifact.data.body}
                </pre>
              </div>
            </details>
          ))}
        </div>
      )}

      {/* Live draft preview (token streaming) */}
      {draftPreview && !artifacts.some((a) => a.data.kind === "draft") && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-indigo-600">
            <span className="inline-block h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />
            Writing draft...
          </div>
          <pre className="whitespace-pre-wrap text-sm text-gray-700 leading-relaxed">
            {draftPreview}
            <span className="animate-pulse">|</span>
          </pre>
        </div>
      )}
    </div>
  );
}
