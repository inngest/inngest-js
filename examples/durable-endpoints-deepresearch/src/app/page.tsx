"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useResearch } from "@/hooks/useResearch";
import {
  TopicInput,
  ClarificationForm,
  ResearchProgress,
  ResearchComplete,
  CodeViewer,
  ExecutionLog,
  LoadingSpinner,
} from "@/components";

export default function Home() {
  // Resizable panel state
  const [logHeight, setLogHeight] = useState(112); // h-28 = 112px default
  const isResizing = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(() => {
    isResizing.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current || !containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const newHeight = containerRect.bottom - e.clientY;
      // Clamp between 80px and 300px
      setLogHeight(Math.max(80, Math.min(300, newHeight)));
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const {
    researchState,
    topic,
    setTopic,
    questions,
    answers,
    setAnswers,
    currentResearchId,
    progress,
    reasoning,
    reasoningHistory,
    isHistoryExpanded,
    setIsHistoryExpanded,
    sources,
    logs,
    report,
    error,
    activeStep,
    currentStepParams,
    stepStatuses,
    durabilityMetrics,
    demoMode,
    handleTopicSubmit,
    handleStartResearch,
    resetState,
  } = useResearch();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header - Compact */}
      <header className="bg-white border-b border-gray-200 p-2 pt-4">
        <div className="max-w-7xl mx-auto px-4 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 bg-gray-900 rounded-lg flex items-center justify-center">
                <svg
                  className="w-4 h-4 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>
              <div>
                <h1 className="text-base font-bold text-gray-900 leading-tight">
                  DeepResearch
                </h1>
                <p className="text-gray-400 text-[10px] leading-tight">
                  Inngest Durable Endpoints
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {demoMode.enabled && (
                <div className="bg-orange-100 border border-orange-300 rounded-lg px-3 py-1.5 flex items-center gap-2">
                  <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse"></span>
                  <span className="text-orange-700 text-xs font-medium">
                    Demo Mode: {demoMode.injectFailure} failures @{" "}
                    {Math.round(demoMode.failureRate * 100)}%
                  </span>
                </div>
              )}
              {currentResearchId && (
                <div className="bg-gray-100 rounded-lg px-3 py-1.5">
                  <span className="text-gray-500 text-xs">ID: </span>
                  <span className="font-mono text-sm font-medium text-gray-700">
                    {currentResearchId}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex h-[calc(100vh-45px)]">
        {/* Left Panel - Research UI */}
        <div className="w-1/2 overflow-auto bg-white border-r border-gray-200">
          <div className="p-4 max-w-xl mx-auto">
            {/* Topic Input (shown when idle) */}
            {researchState === "idle" && (
              <TopicInput
                topic={topic}
                setTopic={setTopic}
                onSubmit={handleTopicSubmit}
              />
            )}

            {/* Loading Clarifications */}
            {researchState === "loading-clarifications" && (
              <div className="space-y-6">
                <div className="bg-gray-50 p-4">
                  <p className="text-sm text-gray-600">
                    <span className="font-medium">Topic:</span> {topic}
                  </p>
                </div>
                <div className="flex flex-col items-center justify-center py-12 space-y-4">
                  <LoadingSpinner size="lg" />
                  <p className="text-gray-600 font-medium">
                    Analyzing your research topic...
                  </p>
                  <p className="text-sm text-gray-400">
                    Generating clarification questions
                  </p>
                </div>
              </div>
            )}

            {/* Clarification Questions */}
            {researchState === "clarifying" && questions.length > 0 && (
              <ClarificationForm
                topic={topic}
                questions={questions}
                answers={answers}
                setAnswers={setAnswers}
                onStartResearch={handleStartResearch}
                onReset={resetState}
              />
            )}

            {/* Research in Progress */}
            {researchState === "researching" && (
              <ResearchProgress
                progress={progress}
                reasoning={reasoning}
                reasoningHistory={reasoningHistory}
                isHistoryExpanded={isHistoryExpanded}
                setIsHistoryExpanded={setIsHistoryExpanded}
                sources={sources}
              />
            )}

            {/* Research Complete */}
            {researchState === "complete" && report && (
              <ResearchComplete
                report={report}
                sources={sources}
                onReset={resetState}
              />
            )}

            {/* Error State */}
            {researchState === "error" && error && (
              <div className="space-y-4">
                <div className="bg-gray-100 border border-gray-400 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-gray-700 text-xl">&#10007;</span>
                    <span className="font-medium text-gray-800">
                      Research Failed
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 font-mono">{error}</p>
                </div>
                <button
                  onClick={resetState}
                  className="w-full bg-gray-900 hover:bg-gray-800 text-white py-3 font-medium transition-colors"
                >
                  Try Again
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right Panel - Code Viewer & Execution Log with resizable split */}
        <div
          ref={containerRef}
          className="w-1/2 flex flex-col bg-white overflow-hidden"
        >
          <div className="flex-1 min-h-0">
            <CodeViewer
              activeStep={activeStep}
              stepStatuses={stepStatuses}
              currentStepParams={currentStepParams}
            />
          </div>
          {/* Resize Handle */}
          <div
            onMouseDown={handleMouseDown}
            className="h-1.5 bg-gray-100 hover:bg-gray-300 cursor-row-resize flex items-center justify-center border-y border-gray-200 transition-colors"
          >
            <div className="w-8 h-0.5 bg-gray-400 rounded-full" />
          </div>
          <ExecutionLog
            logs={logs}
            durabilityMetrics={durabilityMetrics}
            researchState={researchState}
            height={logHeight}
          />
        </div>
      </div>
    </div>
  );
}
