"use client";

import { useInngestSubscription } from "@inngest/realtime/hooks";
import Image from "next/image";
import { useState } from "react";
import { invoke } from "./actions";

export default function Home() {
  const [bufferInterval, setBufferInterval] = useState<number>(0);
  const [enabled, setEnabled] = useState<boolean>(true);
  const [tab, setTab] = useState<"fresh" | "latest">("fresh");

  const { data, error, freshData, state, latestData } = useInngestSubscription({
    refreshToken: invoke,
    bufferInterval,
    enabled,
  });

  const sortedData = [...(data || [])].reverse();

  return (
    <div className="min-h-screen flex flex-col bg-[#1a1a1a] text-[#e0e0e0] font-sans max-w-screen">
      <header className="sticky top-0 z-10 flex items-center justify-between p-6 sm:p-10 border-b border-neutral-700 bg-[#1a1a1a]">
        <div className="flex items-center gap-4">
          <Image
            src="/inngest.svg"
            alt="Next.js logo"
            width={100}
            height={24}
            className="dark:invert"
          />{" "}
          REALTIME
        </div>
        <div className="text-xs text-[#999] font-mono">
          Subscription State:{" "}
          <span className="font-semibold text-white">{state}</span>
        </div>
      </header>

      <div className="flex flex-1 h-[calc(100vh-80px)] overflow-hidden">
        <aside className="w-80 max-w-xs flex-shrink-0 border-r border-neutral-700 p-4 space-y-6 bg-[#2a2a2a] overflow-y-auto">
          <div className="text-sm font-semibold border-b border-neutral-600 pb-1">
            Controls
          </div>

          <button
            onClick={() => setEnabled((prev) => !prev)}
            className="relative w-full py-4 text-center font-bold text-white text-base rounded-xl border border-neutral-600 bg-black hover:border-neutral-500 transition-all"
          >
            <span className="absolute left-4 top-1/2 -translate-y-1/2">
              <span className="relative inline-block w-4 h-4">
                <span
                  className={`absolute inline-block w-4 h-4 rounded-full ${
                    enabled ? "bg-green-400" : "bg-gray-500"
                  }`}
                />
                {enabled && (
                  <span className="absolute inline-block w-4 h-4 rounded-full bg-green-400 opacity-75 animate-ping" />
                )}
              </span>
            </span>
            {enabled ? "Enabled" : "Disabled"}
          </button>

          <label className="block text-sm">
            Buffer Interval (ms): {bufferInterval}
            <input
              type="range"
              min="0"
              max="5000"
              step="100"
              className="w-full mt-1 accent-green-500"
              value={bufferInterval}
              onChange={(e) => setBufferInterval(Number(e.target.value))}
            />
          </label>

          <div className="text-sm space-y-4 pt-2 border-t border-neutral-600">
            <div>
              <div className="font-semibold mb-1 text-white">Error</div>
              <pre className="text-xs bg-neutral-800 p-2 rounded text-red-400 whitespace-pre-wrap break-words max-h-40 overflow-auto">
                {error?.message || "None"}
              </pre>
            </div>
          </div>
        </aside>

        <main className="flex-1 flex overflow-hidden">
          <div className="flex-1 h-full overflow-y-auto p-6 space-y-2">
            <div className="text-lg font-semibold text-white border-b border-neutral-600 pb-2">
              Output Events
            </div>
            {sortedData.length ? (
              <ul className="flex flex-col gap-2">
                {sortedData.map((message, i) => (
                  <li
                    key={i}
                    className="flex flex-col sm:flex-row sm:items-start sm:justify-between bg-[#2a2a2a] px-3 py-2 rounded-xl text-xs sm:text-sm"
                  >
                    <div className="font-mono break-words w-full">
                      <div className="text-[#aaa] mb-1">
                        [
                        {(message.kind === "data"
                          ? new Date(message.createdAt)
                          : new Date()
                        ).toLocaleTimeString()}
                        ]{" "}
                        <strong className="text-white">
                          {message.channel}/{message.topic}
                        </strong>
                      </div>
                      <pre className="text-xs bg-neutral-800 p-2 rounded text-green-300 whitespace-pre-wrap break-words overflow-auto">
                        {JSON.stringify(message.data, null, 2)}
                      </pre>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[#aaa]">No data yet.</div>
            )}
          </div>

          <aside className="w-96 max-w-sm flex-shrink-0 border-l border-neutral-700 bg-[#2a2a2a] p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-4 border-b border-neutral-600 pb-1">
              <div className="text-sm font-semibold text-white">
                Data Inspector
              </div>
              <div className="flex gap-2 text-sm">
                <button
                  className={`px-2 py-1 rounded ${
                    tab === "fresh"
                      ? "bg-neutral-700 text-white"
                      : "text-[#aaa] hover:text-white"
                  }`}
                  onClick={() => setTab("fresh")}
                >
                  Fresh
                </button>
                <button
                  className={`px-2 py-1 rounded ${
                    tab === "latest"
                      ? "bg-neutral-700 text-white"
                      : "text-[#aaa] hover:text-white"
                  }`}
                  onClick={() => setTab("latest")}
                >
                  Latest
                </button>
              </div>
            </div>

            {tab === "fresh" ? (
              freshData?.length ? (
                <pre className="text-xs bg-neutral-800 p-2 rounded text-green-300 whitespace-pre-wrap break-words overflow-auto">
                  {JSON.stringify(freshData, null, 2)}
                </pre>
              ) : (
                <div className="text-xs text-[#aaa]">None</div>
              )
            ) : latestData ? (
              <pre className="text-xs bg-neutral-800 p-2 rounded text-blue-300 whitespace-pre-wrap break-words overflow-auto">
                {JSON.stringify(latestData, null, 2)}
              </pre>
            ) : (
              <div className="text-xs text-[#aaa]">None</div>
            )}
          </aside>
        </main>
      </div>
    </div>
  );
}
