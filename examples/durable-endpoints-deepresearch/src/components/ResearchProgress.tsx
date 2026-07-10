"use client";

import type { Source } from "@/types";
import { LoadingSpinner, ProgressBar } from "./ui";

type ResearchProgressProps = {
  progress: number;
  reasoning: string;
  reasoningHistory: string[];
  isHistoryExpanded: boolean;
  setIsHistoryExpanded: (expanded: boolean) => void;
  sources: Source[];
};

export function ResearchProgress({
  progress,
  reasoning,
  reasoningHistory,
  isHistoryExpanded,
  setIsHistoryExpanded,
  sources,
}: ResearchProgressProps) {
  return (
    <div className="space-y-5">
      {/* Header with sources counter */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-gray-900 flex items-center justify-center">
            <span className="text-white font-bold text-sm">2</span>
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-800">
              Research in Progress
            </h2>
            <p className="text-xs text-gray-500">
              Searching and analyzing sources
            </p>
          </div>
        </div>
        {/* Sources Counter Badge */}
        <div className="flex items-center gap-2 bg-gray-100 text-gray-700 px-3 py-1.5">
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <span className="font-semibold text-sm">{sources.length} Sources</span>
        </div>
      </div>

      {/* Progress Bar */}
      <ProgressBar progress={progress} />

      {/* Current Activity with Expandable History */}
      {reasoning && (
        <div className="bg-gray-50 p-4 border-l-4 border-gray-400">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <LoadingSpinner size="sm" />
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                Current Activity
              </span>
            </div>
            {reasoningHistory.length > 1 && (
              <button
                onClick={() => setIsHistoryExpanded(!isHistoryExpanded)}
                className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 transition-colors"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${
                    isHistoryExpanded ? "rotate-180" : ""
                  }`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
                {isHistoryExpanded
                  ? "Hide history"
                  : `${reasoningHistory.length - 1} previous`}
              </button>
            )}
          </div>

          {/* Expandable History */}
          {isHistoryExpanded && reasoningHistory.length > 1 && (
            <div className="mb-3 max-h-32 overflow-auto border-b border-gray-200 pb-3 space-y-1.5">
              {reasoningHistory.slice(0, -1).map((item, i) => (
                <p
                  key={i}
                  className="text-xs text-gray-500 pl-2 border-l border-gray-300"
                >
                  {item}
                </p>
              ))}
            </div>
          )}

          {/* Current reasoning (always visible) */}
          <p className="text-sm text-gray-700 font-medium">{reasoning}</p>
        </div>
      )}

      {/* Sources Found */}
      {sources.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-700 mb-3">
            Sources Found
          </h3>
          <div className="space-y-2 max-h-48 overflow-auto">
            {sources.map((source, i) => (
              <div
                key={`${source.url}-${i}`}
                className="p-3 bg-white border border-gray-200 animate-fade-in hover:border-gray-400 transition-colors flex items-start gap-3"
                style={{
                  animationDelay: `${Math.min(i * 30, 300)}ms`,
                }}
              >
                {source.favicon ? (
                  <img
                    src={source.favicon}
                    alt=""
                    className="w-5 h-5 rounded flex-shrink-0 mt-0.5"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <div className="w-5 h-5 rounded bg-gray-200 flex-shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-800 hover:underline font-medium text-sm block truncate"
                  >
                    {source.title}
                  </a>
                  <p className="text-xs text-gray-400 truncate mt-0.5">
                    {new URL(source.url).hostname}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming step preview */}
      <div className="pt-4 border-t border-gray-100">
        <div className="flex items-center gap-3 opacity-50">
          <div className="w-8 h-8 bg-gray-200 flex items-center justify-center">
            <span className="text-gray-500 font-bold text-sm">3</span>
          </div>
          <span className="text-sm text-gray-500">Generate Report</span>
        </div>
      </div>
    </div>
  );
}
