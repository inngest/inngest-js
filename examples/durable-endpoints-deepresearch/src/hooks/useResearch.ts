"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  ClarificationQuestion,
  Source,
  ResearchState,
  LogEntry,
  DurabilityMetrics,
  DemoModeSettings,
  StepStatuses,
  StepParams,
} from "@/types";

function generateResearchId(): string {
  return `RES-${crypto.randomUUID().slice(0, 8)}`;
}

export function useResearch() {
  // Core state
  const [researchState, setResearchState] = useState<ResearchState>("idle");
  const [topic, setTopic] = useState("");
  const [questions, setQuestions] = useState<ClarificationQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [currentResearchId, setCurrentResearchId] = useState<string | null>(
    null,
  );

  // Progress state
  const [progress, setProgress] = useState(0);
  const [reasoning, setReasoning] = useState("");
  const [reasoningHistory, setReasoningHistory] = useState<string[]>([]);
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);

  // Results state
  const [sources, setSources] = useState<Source[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Step tracking state
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [currentStepParams, setCurrentStepParams] = useState<StepParams>(null);
  const [stepStatuses, setStepStatuses] = useState<StepStatuses>({
    "generate-queries": "pending",
    "deep-research": "pending",
    "generate-report": "pending",
  });

  // Durability metrics
  const [durabilityMetrics, setDurabilityMetrics] = useState<DurabilityMetrics>(
    {
      totalRetries: 0,
      totalRecoveries: 0,
      steps: {},
    },
  );

  // Demo mode settings
  const [demoMode, setDemoMode] = useState<DemoModeSettings>({
    enabled: false,
    injectFailure: null,
    failureRate: 0.3,
  });

  // Read demo mode settings from URL params on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const injectFailure = urlParams.get("injectFailure");
    const failureRate = urlParams.get("failureRate");

    if (injectFailure) {
      setDemoMode({
        enabled: true,
        injectFailure,
        failureRate: failureRate ? parseFloat(failureRate) : 0.3,
      });
    }
  }, []);

  // Helper functions
  const addLog = useCallback(
    (
      type: LogEntry["type"],
      message: string,
      extra?: Partial<Omit<LogEntry, "timestamp" | "type" | "message">>,
    ) => {
      const timestamp = new Date().toLocaleTimeString();
      setLogs((prev) => [...prev, { timestamp, type, message, ...extra }]);
    },
    [],
  );

  const updateReasoning = useCallback((newReasoning: string) => {
    if (newReasoning && newReasoning.trim()) {
      setReasoning(newReasoning);
      setReasoningHistory((prev) => [...prev, newReasoning]);
    }
  }, []);

  const resetState = useCallback(() => {
    setResearchState("idle");
    setQuestions([]);
    setAnswers({});
    setCurrentResearchId(null);
    setProgress(0);
    setReasoning("");
    setReasoningHistory([]);
    setIsHistoryExpanded(false);
    setSources([]);
    setLogs([]);
    setReport(null);
    setError(null);
    setActiveStep(null);
    setCurrentStepParams(null);
    setStepStatuses({
      "generate-queries": "pending",
      "deep-research": "pending",
      "generate-report": "pending",
    });
    setDurabilityMetrics({
      totalRetries: 0,
      totalRecoveries: 0,
      steps: {},
    });
  }, []);

  // Process a single event from polling
  const processEvent = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data: any) => {
      if (data.type === "clarify-complete") {
        setProgress(data.progress || 5);
        updateReasoning(data.reasoning || "");
        setActiveStep("generate-queries");
        setStepStatuses((prev) => ({ ...prev, "generate-queries": "running" }));
        addLog("info", data.reasoning || "Generating search queries...");
      } else if (data.type === "queries-generated") {
        setProgress(data.progress || 8);
        updateReasoning(data.reasoning || "");
        addLog("reasoning", data.reasoning || "Generated research angles");
      } else if (data.type === "search-start") {
        setProgress(data.progress || 10);
        updateReasoning(data.reasoning || "");
        setActiveStep("search");
        setCurrentStepParams({ query: data.query, depth: data.depth });
        setStepStatuses((prev) => ({
          ...prev,
          "generate-queries": "completed",
          "deep-research": "running",
        }));
        if (data.queryReasoning) {
          addLog("reasoning", `${data.queryAngle}: ${data.queryReasoning}`, {
            queryReasoning: data.queryReasoning,
            queryAngle: data.queryAngle,
          });
        }
        addLog(
          "search",
          `Searching: "${data.query}"${
            data.depth ? ` (Depth ${data.depth})` : ""
          }`,
        );
      } else if (data.type === "source-found") {
        if (data.source) {
          setSources((prev) => [data.source as Source, ...prev]);
          addLog("source", `Found: ${data.source.title}`);
        }
        updateReasoning(data.reasoning || "");
      } else if (data.type === "search-complete") {
        setProgress(data.progress || 0);
        updateReasoning(data.reasoning || "");
      } else if (data.type === "learning-extracted") {
        setActiveStep("learn");
        if (data.learning) {
          addLog(
            "learning",
            `Insight: ${String(data.learning).substring(0, 80)}...`,
            {
              sourceRationale: data.sourceRationale,
              learningConnection: data.learningConnection,
            },
          );
          if (data.sourceRationale) {
            addLog("reasoning", `Source relevance: ${data.sourceRationale}`, {
              sourceRationale: data.sourceRationale,
            });
          }
          if (data.learningConnection) {
            addLog("reasoning", `Connection: ${data.learningConnection}`, {
              learningConnection: data.learningConnection,
            });
          }
        }
        updateReasoning(data.reasoning || "");
      } else if (data.type === "synthesis") {
        if (data.synthesisNote) {
          addLog("synthesis", `Synthesis: ${data.synthesisNote}`, {
            synthesisNote: data.synthesisNote,
          });
        }
        updateReasoning(data.reasoning || "");
      } else if (data.type === "follow-up-reasoning") {
        if (data.followUpReasoning) {
          addLog(
            "follow-up",
            `Next direction: ${data.query} — ${data.followUpReasoning}`,
            { followUpReasoning: data.followUpReasoning },
          );
        }
        updateReasoning(data.reasoning || "");
      } else if (data.type === "depth-complete") {
        setProgress(data.progress || 0);
        updateReasoning(data.reasoning || "");
      } else if (data.type === "report-generating") {
        setProgress(data.progress || 95);
        updateReasoning(data.reasoning || "Generating report...");
        setActiveStep("generate-report");
        setStepStatuses((prev) => ({
          ...prev,
          "deep-research": "completed",
          "generate-report": "running",
        }));
        addLog("info", "Generating comprehensive report...");
      } else if (data.type === "complete") {
        setProgress(100);
        updateReasoning("Research complete!");
        setStepStatuses((prev) => ({
          ...prev,
          "generate-report": "completed",
        }));
        setActiveStep(null);
        setCurrentStepParams(null);
        setResearchState("complete");
        addLog("complete", "Research complete!");
      } else if (data.type === "error") {
        setError(data.error || "Research failed");
        setResearchState("error");
        addLog("error", `Error: ${data.error || "Unknown error"}`);
      } else if (data.type === "step-retry") {
        const stepId = String(data.stepId || "unknown");
        const attempt = Number(data.attempt || 1);
        const maxAttempts = Number(data.maxAttempts || 3);
        const errorMsg = String(data.errorMessage || "Unknown error");
        addLog(
          "retry",
          `Retrying ${stepId} (${attempt}/${maxAttempts}): ${errorMsg}`,
        );
        updateReasoning(data.reasoning || `Retrying step...`);
        setDurabilityMetrics((prev) => ({
          ...prev,
          totalRetries: prev.totalRetries + 1,
          steps: {
            ...prev.steps,
            [stepId]: {
              ...prev.steps[stepId],
              retryCount: (prev.steps[stepId]?.retryCount || 0) + 1,
            },
          },
        }));
      } else if (data.type === "step-recovered") {
        const stepId = String(data.stepId || "unknown");
        const attempt = Number(data.attempt || 1);
        const duration = data.duration as number | undefined;
        addLog(
          "recovered",
          `✓ Recovered ${stepId} after ${attempt - 1} retries`,
          {
            duration,
          },
        );
        updateReasoning(data.reasoning || `Step recovered!`);
        setDurabilityMetrics((prev) => ({
          ...prev,
          totalRecoveries: prev.totalRecoveries + 1,
          steps: {
            ...prev.steps,
            [stepId]: {
              ...prev.steps[stepId],
              duration: duration,
              retryCount: prev.steps[stepId]?.retryCount || 0,
            },
          },
        }));
      }
    },
    [addLog, updateReasoning],
  );

  // Submit topic and get clarification questions
  const handleTopicSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!topic.trim()) return;

      setResearchState("loading-clarifications");
      addLog("info", `Getting clarification questions for: "${topic}"`);

      try {
        const res = await fetch(
          `/api/research/clarify?topic=${encodeURIComponent(topic)}`
        );

        const data = await res.json();

        if (data.questions) {
          setQuestions(data.questions);
          setResearchState("clarifying");
          addLog(
            "info",
            `Received ${data.questions.length} clarification questions`,
          );
        } else {
          throw new Error(data.error || "Failed to get questions");
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to get questions",
        );
        setResearchState("error");
        addLog(
          "error",
          `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
        );
      }
    },
    [topic, addLog],
  );

  // Submit answers and start research
  const handleStartResearch = useCallback(async () => {
    const researchId = generateResearchId();
    setCurrentResearchId(researchId);
    setResearchState("researching");
    addLog("info", `Starting research with ID: ${researchId}`);

    const params = new URLSearchParams({
      researchId,
      topic,
      clarifications: JSON.stringify(answers),
      depth: "3",
      breadth: "3",
    });

    if (demoMode.enabled && demoMode.injectFailure) {
      params.set("injectFailure", demoMode.injectFailure);
      params.set("failureRate", demoMode.failureRate.toString());
    }

    // Start the research request (runs in background)
    fetch(`/api/research?${params.toString()}`)
      .then((res) => {
        console.log("RESEARCH", res.redirected);
        console.log("RESEARCH - ", res.url);
        if (res.redirected) {
          fetch(res.url)
            .then((res) => {
              return res;
            })
            .then((res) => res.json())
            .then((data) => {
              if (data.data && data.data.body) {
                const result = JSON.parse(data.data.body);
                setReport(result.report);
              }
            })
            .catch((err) => {
              setError(err.message);
              setResearchState("error");
            });
        }
      })
      .catch((err) => {
        setError(err.message);
        setResearchState("error");
      });

    // Start polling for events
    let cursor = 0;
    let isPolling = true;

    const pollEvents = async () => {
      if (!isPolling) return;

      try {
        const res = await fetch(
          `/api/research/events?researchId=${encodeURIComponent(
            researchId
          )}&cursor=${cursor}`
        );
        const { events, cursor: nextCursor, status } = await res.json();

        cursor = nextCursor;

        for (const data of events) {
          processEvent(data);

          if (data.type === "complete" || data.type === "error") {
            isPolling = false;
            return;
          }
        }

        if (status === "running" || status === "pending") {
          setTimeout(pollEvents, 500);
        }
      } catch (err) {
        console.error("Polling error:", err);
        setTimeout(pollEvents, 1000);
      }
    };

    addLog("info", "Starting deep research...");
    pollEvents();
  }, [topic, answers, demoMode, addLog, processEvent]);

  return {
    // State
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

    // Actions
    handleTopicSubmit,
    handleStartResearch,
    resetState,
  };
}
