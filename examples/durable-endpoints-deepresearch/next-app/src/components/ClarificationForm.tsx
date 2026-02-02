"use client";

import type { ClarificationQuestion } from "@/types";

type ClarificationFormProps = {
  topic: string;
  questions: ClarificationQuestion[];
  answers: Record<string, string>;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onStartResearch: () => void;
  onReset: () => void;
};

export function ClarificationForm({
  topic,
  questions,
  answers,
  setAnswers,
  onStartResearch,
  onReset,
}: ClarificationFormProps) {
  return (
    <div className="space-y-5">
      {/* Research Plan Header */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 bg-gray-900 flex items-center justify-center">
          <span className="text-white font-bold text-sm">1</span>
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-800">Research Plan</h2>
          <p className="text-xs text-gray-500">
            Answer these questions to refine your research
          </p>
        </div>
      </div>

      {/* Topic Card */}
      <div className="bg-gray-100 border border-gray-200 p-3">
        <p className="text-sm text-gray-700">
          <span className="font-semibold">Topic:</span> {topic}
        </p>
      </div>

      {/* Questions as numbered list */}
      <div className="space-y-4 pl-2">
        {questions.map((q, index) => {
          const currentAnswer = answers[q.id] || "";
          const selectedOptions = currentAnswer
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);

          const handleOptionClick = (option: string) => {
            const optionLower = option.toLowerCase();
            const isSelected = selectedOptions.includes(optionLower);

            if (isSelected) {
              const newOptions = selectedOptions.filter((s) => s !== optionLower);
              setAnswers((prev) => ({
                ...prev,
                [q.id]: newOptions.join(", "),
              }));
            } else {
              const newAnswer = currentAnswer
                ? `${currentAnswer}, ${option}`
                : option;
              setAnswers((prev) => ({
                ...prev,
                [q.id]: newAnswer,
              }));
            }
          };

          return (
            <div key={q.id} className="flex gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-gray-200 rounded-full flex items-center justify-center mt-1">
                <span className="text-xs font-medium text-gray-600">
                  {index + 1}
                </span>
              </div>
              <div className="flex-1 space-y-2">
                <label className="block text-sm font-medium text-gray-700">
                  {q.question}
                </label>
                {/* Clickable options */}
                {q.options && q.options.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {q.options.map((option) => {
                      const isSelected = selectedOptions.includes(
                        option.toLowerCase()
                      );
                      return (
                        <button
                          key={option}
                          type="button"
                          onClick={() => handleOptionClick(option)}
                          className={`px-3 py-1.5 text-xs border transition-all ${
                            isSelected
                              ? "bg-gray-900 text-white border-gray-900"
                              : "bg-white text-gray-600 border-gray-300 hover:border-gray-400 hover:bg-gray-50"
                          }`}
                        >
                          {option}
                        </button>
                      );
                    })}
                  </div>
                )}
                <input
                  type="text"
                  value={answers[q.id] || ""}
                  onChange={(e) =>
                    setAnswers((prev) => ({
                      ...prev,
                      [q.id]: e.target.value,
                    }))
                  }
                  className="w-full p-3 border border-gray-200 focus:ring-2 focus:ring-gray-900 focus:border-gray-900 text-sm"
                  placeholder="Click options above or type your answer..."
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Upcoming steps preview */}
      <div className="space-y-2 pt-4 border-t border-gray-100">
        <div className="flex items-center gap-3 opacity-50">
          <div className="w-8 h-8 bg-gray-200 flex items-center justify-center">
            <span className="text-gray-500 font-bold text-sm">2</span>
          </div>
          <span className="text-sm text-gray-500">Deep Research</span>
        </div>
        <div className="flex items-center gap-3 opacity-50">
          <div className="w-8 h-8 bg-gray-200 flex items-center justify-center">
            <span className="text-gray-500 font-bold text-sm">3</span>
          </div>
          <span className="text-sm text-gray-500">Generate Report</span>
        </div>
      </div>

      {/* Action Button */}
      <div className="flex items-center justify-between pt-4 border-t border-gray-100">
        <button
          onClick={onReset}
          className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2 hover:bg-gray-100 transition-colors"
        >
          Modify
        </button>
        <button
          onClick={onStartResearch}
          disabled={Object.keys(answers).length < questions.length}
          className="bg-gray-900 hover:bg-gray-800 disabled:bg-gray-300 text-white px-6 py-2 font-medium transition-colors disabled:cursor-not-allowed flex items-center gap-2"
        >
          Start Research
          <span className="text-gray-400">&#x21B5;</span>
        </button>
      </div>
    </div>
  );
}
