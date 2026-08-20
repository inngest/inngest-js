"use client";

import { useRef, useEffect } from "react";
import type { LogEntry, DurabilityMetrics, ResearchState } from "@/types";

type ExecutionLogProps = {
  logs: LogEntry[];
  durabilityMetrics: DurabilityMetrics;
  researchState: ResearchState;
  height?: number;
};

export function ExecutionLog({
  logs,
  durabilityMetrics,
  researchState,
  height = 112,
}: ExecutionLogProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div
      className="flex-shrink-0 bg-white flex flex-col"
      style={{ height: `${height}px` }}
    >
      <div className="px-3 py-1.5 border-b border-gray-200 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700 flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              researchState === "researching"
                ? "bg-green-500 animate-pulse"
                : "bg-gray-400"
            }`}
          ></span>
          Execution Log
        </span>
        <div className="flex items-center gap-3">
          {durabilityMetrics.totalRetries > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-600">
              {durabilityMetrics.totalRetries} retries
            </span>
          )}
          {durabilityMetrics.totalRecoveries > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-600">
              {durabilityMetrics.totalRecoveries} recovered
            </span>
          )}
          {logs.length > 0 && (
            <span className="text-xs text-gray-400">{logs.length} events</span>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3 font-mono text-xs bg-gray-50">
        {logs.length === 0 ? (
          <div className="text-gray-400 p-2">
            Waiting for research request...
          </div>
        ) : (
          <>
            {logs.map((log, i) => (
              <div
                key={i}
                className={`py-0.5 ${
                  log.type === "error"
                    ? "text-red-600"
                    : log.type === "complete"
                      ? "text-green-600"
                      : log.type === "source"
                        ? "text-blue-600"
                        : log.type === "learning"
                          ? "text-purple-600"
                          : log.type === "search"
                            ? "text-amber-600"
                            : log.type === "retry"
                              ? "text-orange-500"
                              : log.type === "recovered"
                                ? "text-emerald-600 font-medium"
                                : log.type === "reasoning"
                                  ? "text-cyan-600 italic"
                                  : log.type === "synthesis"
                                    ? "text-indigo-600 font-medium"
                                    : log.type === "follow-up"
                                      ? "text-teal-600"
                                      : "text-gray-600"
                }`}
              >
                <span className="text-gray-400">[{log.timestamp}]</span>{" "}
                {log.message}
                {log.duration && (
                  <span className="text-gray-400 ml-1">
                    ({(log.duration / 1000).toFixed(1)}s)
                  </span>
                )}
              </div>
            ))}
            <div ref={logsEndRef} />
          </>
        )}
      </div>
    </div>
  );
}
