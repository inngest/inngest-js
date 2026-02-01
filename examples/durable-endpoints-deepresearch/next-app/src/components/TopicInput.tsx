"use client";

type TopicInputProps = {
  topic: string;
  setTopic: (topic: string) => void;
  onSubmit: (e: React.FormEvent) => void;
};

export function TopicInput({ topic, setTopic, onSubmit }: TopicInputProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <label className="block text-sm font-bold text-gray-800 mb-1.5">
          What would you like to research?
        </label>
        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="e.g., What are the latest developments in quantum computing for drug discovery?"
          className="w-full p-3 border border-gray-300 focus:ring-2 focus:ring-gray-900 focus:border-gray-900 resize-none h-24 text-sm"
          required
        />
      </div>
      <button
        type="submit"
        className="w-full bg-gray-900 hover:bg-gray-800 text-white py-2.5 text-sm font-medium transition-colors"
      >
        Start Research
      </button>
    </form>
  );
}
