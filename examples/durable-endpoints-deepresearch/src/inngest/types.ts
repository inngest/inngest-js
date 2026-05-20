/**
 * Type definitions for the DeepResearch API
 */

// Type for research progress events sent to the client
export type ResearchEvent = {
  type:
    | "connected"
    | "clarify-complete"
    | "queries-generated"
    | "search-start"
    | "search-complete"
    | "source-found"
    | "learning-extracted"
    | "synthesis"
    | "follow-up-reasoning"
    | "depth-complete"
    | "report-generating"
    | "complete"
    | "error"
    | "step-retry"
    | "step-recovered";
  depth?: number;
  query?: string;
  source?: { title: string; url: string; favicon?: string };
  learning?: string;
  progress?: number;
  reasoning?: string;
  result?: unknown;
  error?: string;
  timestamp: string;
  // Retry tracking fields
  stepId?: string;
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: string;
  // Step metrics
  duration?: number;
  retryCount?: number;
  // Rich reasoning fields
  queryReasoning?: string;
  queryAngle?: string;
  sourceRationale?: string;
  learningConnection?: string;
  synthesisNote?: string;
  followUpReasoning?: string;
};

// Type for a source document
export type Source = {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
  favicon?: string;
};

// Type for accumulated research state
export type AccumulatedResearch = {
  topic: string;
  sources: Source[];
  learnings: string[];
  queries: string[];
};

// Type for a search query with reasoning
export type QueryWithReasoning = {
  query: string;
  reasoning: string;
  angle: string;
};

// Union type for queries (plain strings or with reasoning)
export type QueryInput = string | QueryWithReasoning;

// Type for a learning with reasoning
export type LearningWithReasoning = {
  insight: string;
  sourceRationale: string;
  connection?: string;
};

// Type for a follow-up query with reasoning
export type FollowUpWithReasoning = {
  query: string;
  reasoning: string;
};

// Return type for extractLearnings
export type ExtractedLearnings = {
  learnings: LearningWithReasoning[];
  followUps: FollowUpWithReasoning[];
  synthesisNote: string;
};
