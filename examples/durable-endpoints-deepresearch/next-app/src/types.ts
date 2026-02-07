// Shared types for DeepResearch demo

export type ClarificationQuestion = {
  id: string;
  question: string;
  options?: string[];
};

export type Source = {
  title: string;
  url: string;
  favicon?: string;
};

export type ResearchState =
  | "idle"
  | "loading-clarifications"
  | "clarifying"
  | "researching"
  | "complete"
  | "error";

export type LogEntry = {
  timestamp: string;
  type:
    | "info"
    | "search"
    | "source"
    | "learning"
    | "complete"
    | "error"
    | "retry"
    | "recovered"
    | "reasoning"
    | "synthesis"
    | "follow-up";
  message: string;
  duration?: number;
  queryReasoning?: string;
  queryAngle?: string;
  sourceRationale?: string;
  learningConnection?: string;
  synthesisNote?: string;
  followUpReasoning?: string;
};

export type DurabilityMetrics = {
  totalRetries: number;
  totalRecoveries: number;
  steps: Record<string, { duration?: number; retryCount: number }>;
};

export type DemoModeSettings = {
  enabled: boolean;
  injectFailure: string | null;
  failureRate: number;
};

export type StepStatuses = Record<string, "pending" | "running" | "completed">;

export type StepParams = {
  query?: string;
  depth?: number;
} | null;
