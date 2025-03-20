"use client";
import Link from "next/link";
import { useState } from "react";

export function HelloWorld() {
  const [updates, setUpdates] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async () => {
    setIsLoading(true);
    setUpdates([]);

    try {
      const response = await fetch("/api/hello-world", {
        method: "POST",
      });

      const reader = response.body?.getReader();
      if (!reader) {
        setIsLoading(false);

        return;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const text = new TextDecoder().decode(value);
        const data = JSON.parse(text).data;

        setUpdates((prev) => [...prev, data]);
        if (data === "Bye!") {
          setIsLoading(false);
          reader.cancel();
          break;
        }
      }
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-3xl max-w-full bg-gray-50 min-h-screen flex flex-col px-20">
      <div className="flex pt-6 px-6">
        <Link
          href="/"
          className={`px-3 py-1.5 bg-white text-black rounded-md border border-gray-200 hover:bg-gray-100 focus:outline-none disabled:opacity-70 transition-all duration-300 ease-in-out`}
        >
          Back to examples
        </Link>
      </div>
      <div className="p-6">
        <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm mb-6 flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-900">
            Realtime Hello World
          </h2>
          <button
            onClick={handleSubmit}
            className={`px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-black focus:outline-none disabled:opacity-70 transition-all duration-300 ease-in-out ${
              isLoading && "scale-90 opacity-70"
            }`}
            disabled={isLoading}
          >
            {isLoading ? "Running..." : "Run"}
          </button>
        </div>

        {updates.length > 0 && (
          <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm mb-4">
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
    </div>
  );
}
