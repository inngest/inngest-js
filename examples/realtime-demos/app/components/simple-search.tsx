"use client";
import { useState, useRef, useEffect } from "react";

export function SimpleSearch() {
  const [updates, setUpdates] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [floatingInput, setFloatingInput] = useState("");
  const [isInputVisible, setIsInputVisible] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!floatingInput.trim()) return;

    // Hide the input with animation
    setIsInputVisible(false);
    setIsLoading(true);
    setUpdates([]);

    try {
      const response = await fetch("/api/simple-search", {
        method: "POST",
        body: JSON.stringify({ prompt: floatingInput }),
      });

      const reader = response.body?.getReader();
      if (!reader) {
        setIsLoading(false);
        setIsInputVisible(true);
        return;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const text = new TextDecoder().decode(value);
        const data = JSON.parse(text).data;
        if (data === "Search complete") {
          setIsLoading(false);
          setIsInputVisible(true);
          reader.cancel();
          break;
        } else {
          setUpdates((prev) => [...prev, data]);
        }
      }
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setIsLoading(false);
      setFloatingInput("");
      // Show the input again with animation
      setIsInputVisible(true);

      // Focus the input after it reappears
      setTimeout(() => {
        inputRef.current?.focus();
      }, 300);
    }
  };

  const handleFloatingInputChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setFloatingInput(e.target.value);
  };

  return (
    <div className="max-w-3xl max-w-full bg-gray-50 min-h-screen flex flex-col">
      <div className="p-6">
        <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm mb-6">
          <h2 className="text-xl font-bold text-gray-900">
            AgentKit Web Search
          </h2>
        </div>

        {isLoading && (
          <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm mb-4">
            <div className="flex items-center">
              <div className="w-4 h-4 mr-2 rounded-full bg-gray-200"></div>
              <p className="text-gray-600 text-sm">Processing request...</p>
            </div>
          </div>
        )}

        {updates.length > 0 && (
          <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm mb-4">
            <div className="flex items-center mb-3">
              <div className="w-4 h-4 rounded-full bg-gray-200 mr-2"></div>
              <h3 className="text-base font-medium text-gray-800">Results</h3>
            </div>
            <div className="space-y-3">
              {updates.map((update, index) => (
                <div
                  key={index}
                  className="p-3 bg-gray-50 rounded border border-gray-200"
                >
                  <p className="text-gray-700 text-sm">{update}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Floating input at the bottom */}
      <div className="mt-auto p-4 border-t border-gray-200 bg-white overflow-hidden">
        <form onSubmit={handleSubmit} className="flex items-center">
          <div
            className={`flex-1 transition-all duration-300 ease-in-out transform ${
              isInputVisible
                ? "translate-y-0 opacity-100"
                : "translate-y-full opacity-0"
            }`}
          >
            <input
              ref={inputRef}
              className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-gray-400 text-gray-700"
              placeholder="Type a message..."
              value={floatingInput}
              onChange={handleFloatingInputChange}
            />
          </div>
          <button
            type="submit"
            className={`ml-2 px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-black focus:outline-none disabled:opacity-70 transition-all duration-300 ease-in-out ${
              !isInputVisible && "scale-90 opacity-70"
            }`}
            disabled={isLoading || !isInputVisible}
          >
            {isLoading ? "Searching..." : "Submit"}
          </button>
        </form>
      </div>
    </div>
  );
}
