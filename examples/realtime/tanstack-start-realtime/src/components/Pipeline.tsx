import { useState, useEffect, useRef } from "react";
import type { UseRealtimeResult } from "inngest/react";
import type { contentPipeline } from "../inngest/channels";
import { StatusBadge } from "./StatusBadge";

//
// Derive props from the hook's return type, parameterized by our channel.
// This gives us per-topic typed message access without manual annotations.
type PipelineResult = UseRealtimeResult<
  ReturnType<typeof contentPipeline>,
  readonly ["status", "tokens", "artifact"]
>;

interface PipelineProps {
  connectionStatus: PipelineResult["connectionStatus"];
  runStatus: PipelineResult["runStatus"];
  messagesByTopic: PipelineResult["messages"]["byTopic"];
}

const stepOrder = ["research", "outline", "draft"] as const;

const stepLabels: Record<string, string> = {
  research: "Research Notes",
  outline: "Post Outline",
  draft: "Final Draft",
};

export function Pipeline({
  connectionStatus,
  runStatus,
  messagesByTopic,
}: PipelineProps) {
  //
  // Per-topic typing: messagesByTopic.status?.data is automatically typed as
  // { message: string; step?: string } — no `as` cast needed.
  const currentStatus = messagesByTopic.status?.data;
  const activeStep = currentStatus?.step;

  //
  // Accumulate artifacts in state so they persist after the step completes.
  // messagesByTopic.artifact?.data is typed as { kind: "research" | "outline" | "draft"; title: string; body: string }
  type Artifact = NonNullable<typeof messagesByTopic.artifact>["data"];

  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  useEffect(() => {
    const data = messagesByTopic.artifact?.data;
    if (data) {
      setArtifacts((prev) => {
        if (prev.some((a) => a.kind === data.kind)) return prev;
        return [...prev, data];
      });
    }
  }, [messagesByTopic.artifact]);

  //
  // Accumulate streaming tokens per step from topic messages.
  // messagesByTopic.tokens?.data is typed as { token: string; step: string }
  const [streamingText, setStreamingText] = useState<Record<string, string>>(
    {},
  );

  useEffect(() => {
    const msg = messagesByTopic.tokens;
    if (!msg || msg.kind !== "data") return;
    const { token, step } = msg.data;
    setStreamingText((prev) => ({
      ...prev,
      [step]: (prev[step] ?? "") + token,
    }));
  }, [messagesByTopic.tokens]);

  //
  // Auto-scroll to the bottom of the active section on every new token.
  const scrollAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollAnchorRef.current;
    if (!el) return;

    //
    // Position the streaming edge ~80% down the viewport instead of flush
    // against the bottom, so there's breathing room below.
    const y = el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.8;
    window.scrollTo({ top: y, behavior: "smooth" });
  }, [messagesByTopic.tokens, activeStep]);

  const isActive =
    connectionStatus === "open" || connectionStatus === "connecting";
  const isDone =
    runStatus === "completed" ||
    runStatus === "failed" ||
    runStatus === "cancelled";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <StatusBadge
          connectionStatus={connectionStatus}
          runStatus={runStatus}
        />
        {currentStatus && isActive && (
          <span className="text-sm font-medium text-indigo-600 animate-pulse">
            {currentStatus.message}
          </span>
        )}
        {isDone && (
          <span className="text-sm text-gray-500">Pipeline complete</span>
        )}
      </div>

      {/* Step progress indicators */}
      <div className="flex gap-2">
        {stepOrder.map((step) => {
          const isCurrentStep = activeStep === step;
          const hasArtifact = artifacts.some((a) => a.kind === step);
          const isPast =
            activeStep &&
            stepOrder.indexOf(
              activeStep as (typeof stepOrder)[number],
            ) > stepOrder.indexOf(step);

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

      {/* Per-step streaming sections */}
      <div className="space-y-4">
        {stepOrder.map((step) => {
          const artifact = artifacts.find((a) => a.kind === step);
          const streaming = streamingText[step];
          if (!artifact && !streaming) return null;

          const isCurrentStep = activeStep === step;
          const isStreaming = isCurrentStep && !artifact;
          const isCompleted = !!artifact && !isCurrentStep;
          const text = artifact?.body ?? streaming ?? "";

          return (
            <div
              key={step}
              className={`rounded-lg border overflow-hidden transition-colors ${
                isStreaming
                  ? "border-indigo-200 bg-indigo-50/30"
                  : "border-gray-200 bg-white"
              }`}
            >
              <div className="flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700">
                <span className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      isStreaming
                        ? "bg-indigo-500 animate-pulse"
                        : "bg-green-500"
                    }`}
                  />
                  {stepLabels[step]}
                </span>
                <span className="text-xs text-gray-400 capitalize">
                  {step}
                </span>
              </div>
              <div
                className={`border-t border-gray-100 px-4 py-3 relative ${
                  isCompleted ? "max-h-24 overflow-hidden" : ""
                }`}
              >
                <pre className="whitespace-pre-wrap text-sm text-gray-600 leading-relaxed">
                  {text}
                  {isStreaming && (
                    <span className="animate-pulse">|</span>
                  )}
                </pre>
                {isCompleted && (
                  <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white to-transparent" />
                )}
                {isStreaming && <div ref={scrollAnchorRef} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
