"use client";

import ReactMarkdown from "react-markdown";
import type { Source } from "@/types";
import { CitationText } from "./ui";

type ResearchCompleteProps = {
  report: string;
  sources: Source[];
  onReset: () => void;
};

export function ResearchComplete({
  report,
  sources,
  onReset,
}: ResearchCompleteProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-800">Research Report</h2>
        <button
          onClick={onReset}
          className="text-sm text-gray-600 hover:text-gray-900 px-3 py-1 hover:bg-gray-100 transition-colors"
        >
          New Research
        </button>
      </div>

      {/* Report Summary */}
      <div className="bg-gray-100 border border-gray-300 p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-gray-700 text-xl">&#10003;</span>
          <span className="font-medium text-gray-800">Research Complete</span>
        </div>
        <p className="text-sm text-gray-600">
          Found {sources.length} sources across 3 levels of depth
        </p>
      </div>

      {/* Sources Used - Collapsible */}
      <details className="group">
        <summary className="text-sm font-medium text-gray-700 cursor-pointer hover:text-gray-900 flex items-center gap-2">
          <svg
            className="w-4 h-4 transition-transform group-open:rotate-90"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5l7 7-7 7"
            />
          </svg>
          Sources ({sources.length})
        </summary>
        <div className="space-y-1 mt-3 max-h-48 overflow-auto pl-6">
          {sources.map((source, i) => (
            <div
              key={`${source.url}-${i}`}
              className="flex items-center gap-2 py-1"
            >
              <span className="text-xs font-mono text-gray-400 w-6 flex-shrink-0">
                [{i + 1}]
              </span>
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
                className="text-gray-700 hover:text-gray-900 hover:underline text-sm truncate"
              >
                {source.title}
              </a>
            </div>
          ))}
        </div>
      </details>

      {/* Report Content with Citation Support */}
      <div className="prose prose-gray max-w-none prose-headings:text-gray-900 prose-p:text-gray-700 prose-a:text-gray-700 prose-a:underline prose-strong:text-gray-800">
        <ReactMarkdown
          components={{
            p: ({ children }) => (
              <p>
                <CitationText text={String(children)} sources={sources} />
              </p>
            ),
            li: ({ children }) => (
              <li>
                <CitationText text={String(children)} sources={sources} />
              </li>
            ),
          }}
        >
          {report}
        </ReactMarkdown>
      </div>
    </div>
  );
}
