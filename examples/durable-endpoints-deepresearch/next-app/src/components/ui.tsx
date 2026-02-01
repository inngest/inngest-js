"use client";

import type { Source } from "@/types";

// Loading spinner component
export function LoadingSpinner({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-6 h-6",
    lg: "w-8 h-8",
  };
  return (
    <div
      className={`${sizeClasses[size]} border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin`}
    />
  );
}

// Progress Bar - Compact with 2 rows of squares
export function ProgressBar({ progress }: { progress: number }) {
  const rows = 2;
  const cols = 32;
  const filledCols = Math.floor((progress / 100) * cols);

  const getSquareState = (col: number) => {
    const isFilled = col < filledCols;
    const isPulsing = col >= filledCols && col < filledCols + 3;
    return { isFilled, isPulsing };
  };

  return (
    <div className="w-full">
      <div className="flex gap-[2px] w-full justify-between">
        {Array.from({ length: cols }).map((_, col) => (
          <div key={col} className="flex flex-col gap-[2px]">
            {Array.from({ length: rows }).map((_, row) => {
              const { isFilled, isPulsing } = getSquareState(col);
              const pulseDelay = isPulsing
                ? `${(col - filledCols) * 150 + row * 100}ms`
                : "0ms";

              return (
                <div
                  key={row}
                  className={`w-2 h-2 transition-all duration-300 ${
                    isPulsing ? "animate-pulse" : ""
                  }`}
                  style={{
                    backgroundColor: isFilled
                      ? "rgb(55, 65, 81)"
                      : isPulsing
                        ? "rgb(156, 163, 175)"
                        : "rgb(229, 231, 235)",
                    animationDelay: pulseDelay,
                    animationDuration: isPulsing ? "1s" : "0s",
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[10px] text-gray-500">{progress}%</span>
        <span className="text-[10px] text-gray-400">
          {progress < 100 ? "Researching..." : "Complete"}
        </span>
      </div>
    </div>
  );
}

// Citation renderer - makes [1], [2], etc. clickable
export function CitationText({
  text,
  sources,
}: {
  text: string;
  sources: Source[];
}) {
  const parts = text.split(/(\[\d+(?:,\s*\d+)*\]|\[\d+\]\[\d+\])/g);

  return (
    <>
      {parts.map((part, i) => {
        const citationMatch = part.match(/\[(\d+(?:,\s*\d+)*)\]/);
        if (citationMatch) {
          const numbers = part.match(/\d+/g)?.map(Number) || [];
          return (
            <span key={i} className="inline-flex gap-0.5">
              {numbers.map((num, j) => {
                const source = sources[num - 1];
                if (source) {
                  return (
                    <a
                      key={j}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 text-xs font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 rounded transition-colors cursor-pointer"
                      title={source.title}
                    >
                      {num}
                    </a>
                  );
                }
                return (
                  <span
                    key={j}
                    className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 text-xs font-medium bg-gray-100 text-gray-500 rounded"
                  >
                    {num}
                  </span>
                );
              })}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
