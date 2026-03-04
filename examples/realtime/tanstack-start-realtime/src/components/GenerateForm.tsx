import { useState } from "react";

export function GenerateForm({
  onSubmit,
  disabled,
}: {
  onSubmit: (topic: string) => void;
  disabled: boolean;
}) {
  const [topic, setTopic] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = topic.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setTopic("");
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-3">
      <input
        type="text"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder="Enter a topic, e.g. 'The future of WebAssembly'"
        disabled={disabled}
        className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm placeholder:text-gray-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={disabled || !topic.trim()}
        className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {disabled ? "Generating..." : "Generate"}
      </button>
    </form>
  );
}
