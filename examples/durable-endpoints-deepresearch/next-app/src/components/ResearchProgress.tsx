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
    <div className="space-y-3">
      {/* Header with sources counter */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 bg-gray-900 flex items-center justify-center">
            <span className="text-white font-bold text-xs">2</span>
          </div>
          <div>
            <h2 className="text-sm font-bold text-gray-800 leading-tight">
              Research in Progress
            </h2>
            <p className="text-[10px] text-gray-500 leading-tight">
              Searching and analyzing sources
            </p>
          </div>
        </div>
        {/* Sources Counter Badge */}
        <div className="flex items-center gap-1.5 bg-gray-100 text-gray-700 px-2 py-1">
          <svg
            className="w-3.5 h-3.5"
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
          <span className="font-semibold text-xs">{sources.length} Sources</span>
        </div>
      </div>

      {/* Progress Bar */}
      <ProgressBar progress={progress} />

      {/* Current Activity with Expandable History */}
      {reasoning && (
        <div className="bg-gray-50 p-3 border-l-4 border-gray-400">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <LoadingSpinner size="sm" />
              <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                Current Activity
              </span>
            </div>
            {reasoningHistory.length > 1 && (
              <button
                onClick={() => setIsHistoryExpanded(!isHistoryExpanded)}
                className="text-[10px] text-gray-500 hover:text-gray-700 flex items-center gap-1 transition-colors"
              >
                <svg
                  className={`w-2.5 h-2.5 transition-transform ${
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
                  ? "Hide"
                  : `${reasoningHistory.length - 1} prev`}
              </button>
            )}
          </div>

          {/* Expandable History */}
          {isHistoryExpanded && reasoningHistory.length > 1 && (
            <div className="mb-2 max-h-24 overflow-auto border-b border-gray-200 pb-2 space-y-1">
              {reasoningHistory.slice(0, -1).map((item, i) => (
                <p
                  key={i}
                  className="text-[10px] text-gray-500 pl-2 border-l border-gray-300"
                >
                  {item}
                </p>
              ))}
            </div>
          )}

          {/* Current reasoning (always visible) */}
          <p className="text-xs text-gray-700 font-medium">{reasoning}</p>
        </div>
      )}

      {/* Sources Found */}
      {sources.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-gray-700 mb-2">
            Sources Found
          </h3>
          <div className="space-y-1 max-h-40 overflow-auto">
            {sources.map((source, i) => (
              <div
                key={`${source.url}-${i}`}
                className="p-2 bg-white border border-gray-200 animate-fade-in hover:border-gray-400 transition-colors flex items-center gap-2"
                style={{
                  animationDelay: `${Math.min(i * 30, 300)}ms`,
                }}
              >
                {source.favicon ? (
                  <img
                    src={source.favicon}
                    alt=""
                    className="w-4 h-4 rounded flex-shrink-0"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <div className="w-4 h-4 rounded bg-gray-200 flex-shrink-0" />
                )}
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-800 hover:underline font-medium text-xs truncate flex-1"
                >
                  {source.title}
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming step preview */}
      <div className="pt-2 border-t border-gray-100">
        <div className="flex items-center gap-2 opacity-50">
          <div className="w-5 h-5 bg-gray-200 flex items-center justify-center">
            <span className="text-gray-500 font-bold text-[10px]">3</span>
          </div>
          <span className="text-xs text-gray-500">Generate Report</span>
        </div>
      </div>
    </div>
  );
}
