/**
 * Durable Endpoint for DeepResearch with SSE progress streaming
 *
 * Uses createExperimentalEndpointWrapper() to make the HTTP handler durable.
 * Streams real-time progress updates via Server-Sent Events.
 */

import { Inngest, step } from "inngest";
import { endpointAdapter } from "inngest/edge";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, generateObject } from "ai";
import { z } from "zod";
import Exa from "exa-js";
import { createHash } from "crypto";

const inngest = new Inngest({ id: "deepresearch-backend", endpointAdapter });

// Initialize Exa client
const exa = new Exa(process.env.EXA_API_KEY || "");

// Type for research progress events
export type ResearchEvent = {
  type:
    | "connected"
    | "clarify-complete"
    | "queries-generated" // NEW: Initial queries with reasoning
    | "search-start"
    | "search-complete"
    | "source-found"
    | "learning-extracted"
    | "synthesis" // NEW: Synthesis of how findings connect
    | "follow-up-reasoning" // NEW: Why we're exploring a follow-up
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
  queryReasoning?: string; // Why this query was chosen
  queryAngle?: string; // The angle/perspective being explored
  sourceRationale?: string; // Why a source is relevant
  learningConnection?: string; // How learning connects to others
  synthesisNote?: string; // How findings fit together
  followUpReasoning?: string; // Why a follow-up is worth exploring
};

// Type for a source
export type Source = {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
  favicon?: string;
};

// Type for accumulated research
export type AccumulatedResearch = {
  topic: string;
  sources: Source[];
  learnings: string[];
  queries: string[];
};

// ============================================================
// EVENT STORE (polling-based approach to avoid SSE timeout limits)
// ============================================================

type EventStore = {
  events: Array<ResearchEvent & { seq: number }>;
  nextSeq: number;
  createdAt: number;
  status: "running" | "complete" | "error";
};

// Store for research events (researchId -> EventStore)
const eventStores = new Map<string, EventStore>();

// Cleanup old event stores after 30 minutes
const EVENT_STORE_TTL = 30 * 60 * 1000;

function cleanupOldEventStores() {
  const now = Date.now();
  for (const [researchId, store] of eventStores.entries()) {
    if (now - store.createdAt > EVENT_STORE_TTL) {
      eventStores.delete(researchId);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupOldEventStores, 5 * 60 * 1000);

/**
 * Get or create an event store for a research session
 */
function getEventStore(researchId: string): EventStore {
  let store = eventStores.get(researchId);
  if (!store) {
    store = {
      events: [],
      nextSeq: 0,
      createdAt: Date.now(),
      status: "running",
    };
    eventStores.set(researchId, store);
  }
  return store;
}

/**
 * Emit a progress event for a research session (stores for polling)
 */
function emitProgress(
  researchId: string,
  event: Omit<ResearchEvent, "timestamp">,
) {
  const store = getEventStore(researchId);
  const fullEvent = {
    ...event,
    timestamp: new Date().toISOString(),
    seq: store.nextSeq++,
  };
  store.events.push(fullEvent);

  // Update status on completion or error
  if (event.type === "complete") {
    store.status = "complete";
  } else if (event.type === "error") {
    store.status = "error";
  }
}

/**
 * Generate a short hash for step IDs
 */
function hashQuery(query: string): string {
  return createHash("md5").update(query).digest("hex").substring(0, 8);
}

/**
 * Calculate progress percentage based on depth and breadth
 */
function calculateProgress(
  currentDepth: number,
  maxDepth: number,
  currentQuery: number,
  totalQueries: number,
): number {
  const depthProgress = ((maxDepth - currentDepth) / maxDepth) * 100;
  const queryProgress = (currentQuery / totalQueries) * (100 / maxDepth);
  return Math.min(Math.round(depthProgress + queryProgress), 95);
}

// ============================================================
// FAILURE INJECTION (for durability demos)
// ============================================================

/**
 * Check if a failure should be simulated for this step.
 * Throws an error if failure should be injected - Inngest will handle retries.
 */
function maybeInjectFailure(
  stepType: string,
  injectFailure: string | null,
  failureRate: number,
): void {
  if (!injectFailure || injectFailure !== stepType) return;
  if (Math.random() < failureRate) {
    throw new Error(`Simulated ${stepType} failure (demo)`);
  }
}

// ============================================================
// CLARIFICATION ENDPOINT
// ============================================================

// Zod schema for clarification questions
const ClarificationQuestionsSchema = z.object({
  questions: z.array(
    z.object({
      id: z
        .string()
        .describe(
          "A short identifier for the question (e.g., 'scope', 'recency')",
        ),
      question: z
        .string()
        .describe("The clarification question to ask the user"),
      options: z
        .array(z.string())
        .describe("2-4 short clickable options for quick selection"),
    }),
  ),
});

/**
 * GET /api/research/clarify?topic=...
 *
 * Generate clarification questions for a research topic
 * This is a Durable Endpoint - the LLM call is wrapped in step.run() for automatic retries
 */
export const clarifyHandler = inngest.endpoint(
  async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const topic = url.searchParams.get("topic");

    if (!topic) {
      return new Response(JSON.stringify({ error: "topic is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log(`[Clarify] Generating questions for: "${topic}"`);

    // Durable step: Generate clarification questions with automatic retry on failure
    const questions = await step.run("generate-clarifications", async () => {
      const { object } = await generateObject({
        model: anthropic("claude-sonnet-4-20250514"),
        schema: ClarificationQuestionsSchema,
        prompt: `You are a research assistant helping to clarify a research topic before conducting deep research.

Given this research topic: "${topic}"

Generate 3-4 clarification questions that will help narrow down the research focus and ensure we find the most relevant information. The questions should help understand:
- The specific aspect or angle the user is interested in
- Any time constraints or recency requirements
- The depth of technical detail needed
- Any specific applications or contexts

For each question, provide 2-4 short clickable options (2-4 words each) that users can click to quickly fill their answer.`,
      });

      return object.questions;
    });

    console.log(`[Clarify] Generated ${questions.length} questions`);

    return new Response(JSON.stringify({ questions }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
);

// ============================================================
// EXA SEARCH HELPER
// ============================================================

async function searchExa(query: string): Promise<Source[]> {
  try {
    const results = await exa.searchAndContents(query, {
      numResults: 5,
      useAutoprompt: true,
      text: { maxCharacters: 2000 },
    });

    return results.results.map((r) => ({
      title: r.title || "Untitled",
      url: r.url,
      content: r.text || "",
      publishedDate: r.publishedDate || undefined,
      favicon: r.favicon || undefined,
    }));
  } catch (error) {
    console.error(`[Exa Search] Error for query "${query}":`, error);
    return [];
  }
}

// ============================================================
// LLM HELPERS
// ============================================================

// Type for query with reasoning
type QueryWithReasoning = {
  query: string;
  reasoning: string; // Why this query was chosen
  angle: string; // The angle/perspective this query explores
};

// Zod schema for search queries with reasoning
const SearchQueriesSchema = z.object({
  queries: z.array(
    z.object({
      query: z.string().describe("The search query"),
      reasoning: z
        .string()
        .describe(
          "Why this query is important - what gap it fills or what aspect it explores",
        ),
      angle: z
        .string()
        .describe(
          "Brief label for the angle (e.g., 'Technical foundations', 'Industry applications')",
        ),
    }),
  ),
});

async function generateSearchQueries(
  topic: string,
  clarifications: Record<string, string>,
  breadth: number,
): Promise<QueryWithReasoning[]> {
  const clarificationContext = Object.entries(clarifications)
    .map(([id, answer]) => `- ${id}: ${answer}`)
    .join("\n");

  const { object } = await generateObject({
    model: anthropic("claude-sonnet-4-20250514"),
    schema: SearchQueriesSchema,
    prompt: `You are a research assistant generating search queries for deep research.

Research topic: "${topic}"

User clarifications:
${clarificationContext || "None provided"}

Generate exactly ${breadth} diverse search queries that will help gather comprehensive information about this topic. Each query should approach the topic from a different angle to ensure broad coverage.

For each query, explain:
1. WHY this query is important for understanding the topic
2. What ANGLE or PERSPECTIVE this query explores`,
  });

  return object.queries;
}

// Type for learning with reasoning
type LearningWithReasoning = {
  insight: string;
  sourceRationale: string; // Why this source is relevant
  connection?: string; // How this connects to other findings (optional)
};

// Type for follow-up query with reasoning
type FollowUpWithReasoning = {
  query: string;
  reasoning: string; // Why this follow-up is worth exploring
};

// Return type for extractLearnings
type ExtractedLearnings = {
  learnings: LearningWithReasoning[];
  followUps: FollowUpWithReasoning[];
  synthesisNote: string; // Overall observation about how findings connect
};

// Zod schema for extracted learnings
const ExtractedLearningsSchema = z.object({
  learnings: z.array(
    z.object({
      insight: z.string().describe("The key finding or learning"),
      sourceRationale: z
        .string()
        .describe("Why this source is credible/relevant for this insight"),
      connection: z
        .string()
        .optional()
        .describe("How this relates to previous findings"),
    }),
  ),
  followUps: z.array(
    z.object({
      query: z.string().describe("A follow-up search query"),
      reasoning: z
        .string()
        .describe(
          "Why this direction is worth exploring based on what we learned",
        ),
    }),
  ),
  synthesisNote: z
    .string()
    .describe(
      "Brief observation about how these findings connect to the bigger picture",
    ),
});

async function extractLearnings(
  topic: string,
  query: string,
  sources: Source[],
  existingLearnings: string[] = [],
): Promise<ExtractedLearnings> {
  if (sources.length === 0) {
    return { learnings: [], followUps: [], synthesisNote: "" };
  }

  const sourceContents = sources
    .map(
      (s, i) =>
        `[Source ${i + 1}: ${s.title}]\n${s.content.substring(0, 1000)}`,
    )
    .join("\n\n");

  const existingContext =
    existingLearnings.length > 0
      ? `\nPrevious learnings from this research:\n${existingLearnings
          .slice(-5)
          .map((l) => `- ${l}`)
          .join("\n")}`
      : "";

  const { object } = await generateObject({
    model: anthropic("claude-sonnet-4-20250514"),
    schema: ExtractedLearningsSchema,
    prompt: `You are a research assistant extracting key learnings from search results and explaining your reasoning.

Overall research topic: "${topic}"
Current search query: "${query}"
${existingContext}

Search results:
${sourceContents}

For each insight you extract, explain:
1. The KEY INSIGHT itself
2. WHY this source is particularly relevant (source rationale)
3. HOW this connects to previous findings (if applicable)

Also identify follow-up queries and explain WHY each is worth exploring.

Finally, provide a brief SYNTHESIS NOTE about how these findings fit together.`,
  });

  return object;
}

async function generateReport(
  topic: string,
  research: AccumulatedResearch,
): Promise<string> {
  // Create numbered sources for citations
  const numberedSources = research.sources.slice(0, 15).map((s, i) => ({
    number: i + 1,
    title: s.title,
    url: s.url,
    content: s.content.substring(0, 500),
  }));

  const sourcesForPrompt = numberedSources
    .map(
      (s) => `[${s.number}] "${s.title}" - ${s.url}\nExcerpt: ${s.content}...`,
    )
    .join("\n\n");

  const learningSummary = research.learnings.join("\n- ");

  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-20250514"),
    prompt: `You are a research expert creating a comprehensive report with proper citations.

Research topic: "${topic}"

Key learnings discovered:
- ${learningSummary}

Numbered sources (use these numbers for citations):
${sourcesForPrompt}

Create a well-structured research report that:
1. Provides an executive summary
2. Covers the main findings organized by theme
3. Highlights key insights and implications
4. Notes areas for further research

IMPORTANT CITATION REQUIREMENTS:
- Use inline citations in the format [1], [2], [3], etc. when referencing information from sources
- Every major claim or finding should have at least one citation
- You can cite multiple sources for one claim like [1][3] or [1, 3]
- At the end of the report, include a "## References" section listing all cited sources in the format:
  [1] Title - URL
  [2] Title - URL
  etc.

Format the report in Markdown. Be comprehensive but concise.`,
  });

  return text;
}

// Union type for queries (can be plain strings or with reasoning)
type QueryInput = string | QueryWithReasoning;

// ============================================================
// RECURSIVE DEEP RESEARCH (parallel execution with Promise.all)
// Uses Inngest's native retry mechanism for durability
// ============================================================

async function deepResearch(
  researchId: string,
  topic: string,
  queries: QueryInput[],
  depth: number,
  maxDepth: number,
  breadth: number,
  accumulated: AccumulatedResearch,
  existingUrls: Set<string>,
  injectFailure: string | null = null,
  failureRate: number = 0.3,
): Promise<AccumulatedResearch> {
  if (depth === 0 || queries.length === 0) {
    return accumulated;
  }

  const baseProgress = calculateProgress(depth, maxDepth, 0, queries.length);

  // Emit search start for all queries with reasoning
  for (const queryInput of queries) {
    const query =
      typeof queryInput === "string" ? queryInput : queryInput.query;
    const queryReasoning =
      typeof queryInput === "string" ? undefined : queryInput.reasoning;
    const queryAngle =
      typeof queryInput === "string" ? undefined : queryInput.angle;

    emitProgress(researchId, {
      type: "search-start",
      depth,
      query,
      progress: baseProgress,
      reasoning: queryReasoning
        ? `Exploring "${queryAngle}": ${query}`
        : `Searching: "${query}" (Depth ${maxDepth - depth + 1}/${maxDepth})`,
      queryReasoning,
      queryAngle,
    });
  }

  // Step 1: Search all queries in parallel using Promise.all
  // Each step.run() is individually durable - Inngest retries failures automatically
  const searchResults = await Promise.all(
    queries.map((queryInput) => {
      const query =
        typeof queryInput === "string" ? queryInput : queryInput.query;
      const stepHash = hashQuery(query);

      return step.run(`search-d${depth}-${stepHash}`, async () => {
        maybeInjectFailure("search", injectFailure, failureRate);
        return { query, results: await searchExa(query) };
      });
    }),
  );

  // Process search results and filter duplicates
  const queryResults: Array<{ query: string; newResults: Source[] }> = [];

  for (const { query, results } of searchResults) {
    const newResults = results.filter((r) => !existingUrls.has(r.url));
    newResults.forEach((r) => existingUrls.add(r.url));

    // Emit sources found
    for (const source of newResults) {
      emitProgress(researchId, {
        type: "source-found",
        depth,
        source: {
          title: source.title,
          url: source.url,
          favicon: source.favicon,
        },
        progress: baseProgress,
        reasoning: `Found: ${source.title}`,
      });
      accumulated.sources.push(source);
    }

    emitProgress(researchId, {
      type: "search-complete",
      depth,
      query,
      progress: baseProgress,
      reasoning: `Found ${newResults.length} new sources for "${query}"`,
    });

    accumulated.queries.push(query);
    queryResults.push({ query, newResults });
  }

  // Step 2: Extract learnings from all results in parallel using Promise.all
  // Each step.run() is individually durable - Inngest retries failures automatically
  const learningsResults = await Promise.all(
    queryResults.map(({ query, newResults }) => {
      const stepHash = hashQuery(query);

      return step.run(`learn-d${depth}-${stepHash}`, async () => {
        maybeInjectFailure("learn", injectFailure, failureRate);
        return {
          query,
          learnings: await extractLearnings(
            topic,
            query,
            newResults,
            accumulated.learnings,
          ),
        };
      });
    }),
  );

  // Collect all follow-up queries with reasoning
  const allFollowUps: QueryInput[] = [];

  for (const { learnings } of learningsResults) {
    // Emit learnings with rich reasoning
    for (const learning of learnings.learnings) {
      emitProgress(researchId, {
        type: "learning-extracted",
        depth,
        learning: learning.insight,
        progress: baseProgress,
        reasoning: `Insight: ${learning.insight.substring(0, 100)}...`,
        sourceRationale: learning.sourceRationale,
        learningConnection: learning.connection,
      });
      accumulated.learnings.push(learning.insight);
    }

    // Emit synthesis note if present
    if (learnings.synthesisNote) {
      emitProgress(researchId, {
        type: "synthesis",
        depth,
        progress: baseProgress,
        synthesisNote: learnings.synthesisNote,
        reasoning: `Synthesis: ${learnings.synthesisNote}`,
      });
    }

    // Collect follow-up queries with reasoning
    for (const followUp of learnings.followUps) {
      emitProgress(researchId, {
        type: "follow-up-reasoning",
        depth,
        query: followUp.query,
        progress: baseProgress,
        followUpReasoning: followUp.reasoning,
        reasoning: `Next: ${followUp.query} — ${followUp.reasoning}`,
      });
      allFollowUps.push({
        query: followUp.query,
        reasoning: followUp.reasoning,
        angle: "Follow-up exploration",
      });
    }
  }

  emitProgress(researchId, {
    type: "depth-complete",
    depth,
    progress: calculateProgress(depth - 1, maxDepth, 0, 1),
    reasoning: `Completed depth ${maxDepth - depth + 1}/${maxDepth}`,
  });

  // Step 3: Recurse with all collected follow-up queries
  if (allFollowUps.length > 0 && depth > 1) {
    const nextBreadth = Math.ceil(breadth / 2);
    const limitedFollowUps = allFollowUps.slice(
      0,
      nextBreadth * queries.length,
    );

    await deepResearch(
      researchId,
      topic,
      limitedFollowUps,
      depth - 1,
      maxDepth,
      nextBreadth,
      accumulated,
      existingUrls,
      injectFailure,
      failureRate,
    );
  }

  return accumulated;
}

// ============================================================
// RESEARCH DURABLE ENDPOINT
// ============================================================

/**
 * GET /api/research?researchId=...&topic=...&clarifications=...&depth=...&breadth=...
 *
 * The durable endpoint that executes the deep research workflow.
 * clarifications is a JSON-encoded object of answers
 */
export const researchHandler = inngest.endpoint(
  async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const researchId = url.searchParams.get("researchId");
    const topic = url.searchParams.get("topic");
    const clarificationsParam = url.searchParams.get("clarifications");
    const depth = parseInt(url.searchParams.get("depth") || "3", 10);
    const breadth = parseInt(url.searchParams.get("breadth") || "3", 10);

    // Failure injection params for durability demos
    // Usage: ?injectFailure=search&failureRate=0.5
    const injectFailure = url.searchParams.get("injectFailure"); // "search" | "learn" | "report"
    const failureRate = parseFloat(
      url.searchParams.get("failureRate") || "0.3",
    );

    // Parse clarifications from JSON string
    let clarifications: Record<string, string> = {};
    if (clarificationsParam) {
      try {
        clarifications = JSON.parse(clarificationsParam);
      } catch {
        // Ignore parse errors, use empty object
      }
    }

    if (!topic || !researchId) {
      return new Response(
        JSON.stringify({ error: "topic and researchId are required" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    console.log(
      `[Research ${researchId}] Starting deep research for: "${topic}"`,
    );

    const accumulated: AccumulatedResearch = {
      topic,
      sources: [],
      learnings: [],
      queries: [],
    };
    const existingUrls = new Set<string>();

    try {
      // Step 1: Generate initial search queries
      emitProgress(researchId, {
        type: "clarify-complete",
        progress: 5,
        reasoning:
          "Generating search queries based on your topic and clarifications...",
      });

      const initialQueries = await step.run("generate-queries", async () => {
        return await generateSearchQueries(topic, clarifications, breadth);
      });

      console.log(
        `[Research ${researchId}] Generated ${initialQueries.length} initial queries`,
      );

      // Emit queries with their reasoning
      emitProgress(researchId, {
        type: "queries-generated",
        progress: 8,
        reasoning: `Generated ${initialQueries.length} research angles to explore`,
      });

      // Emit reasoning for each query
      for (const q of initialQueries) {
        emitProgress(researchId, {
          type: "search-start",
          query: q.query,
          queryReasoning: q.reasoning,
          queryAngle: q.angle,
          progress: 10,
          reasoning: `Planning: "${q.angle}" — ${q.reasoning}`,
        });
      }

      // Step 2: Execute recursive deep research (parallel execution)
      await deepResearch(
        researchId,
        topic,
        initialQueries,
        depth,
        depth,
        breadth,
        accumulated,
        existingUrls,
        injectFailure,
        failureRate,
      );

      // Step 3: Generate final report
      emitProgress(researchId, {
        type: "report-generating",
        progress: 95,
        reasoning: "Synthesizing findings into a comprehensive report...",
      });

      const report = await step.run("generate-report", async () => {
        // Throw if failure injection is enabled - Inngest handles retry
        maybeInjectFailure("report", injectFailure, failureRate);
        return await generateReport(topic, accumulated);
      });

      console.log(
        `[Research ${researchId}] Research complete. ${accumulated.sources.length} sources, ${accumulated.learnings.length} learnings`,
      );

      // Emit completion
      emitProgress(researchId, {
        type: "complete",
        progress: 100,
        reasoning: "Research complete!",
        result: {
          report,
          sourcesCount: accumulated.sources.length,
          learningsCount: accumulated.learnings.length,
        },
      });

      return new Response(
        JSON.stringify({
          success: true,
          researchId,
          topic,
          report,
          sources: accumulated.sources,
          learnings: accumulated.learnings,
          queries: accumulated.queries,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error(`[Research ${researchId}] Error:`, error);

      emitProgress(researchId, {
        type: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        reasoning: "Research failed due to an error",
      });

      return new Response(
        JSON.stringify({
          success: false,
          error: error instanceof Error ? error.message : "Research failed",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
);

// ============================================================
// POLLING EVENTS ENDPOINT
// ============================================================

/**
 * GET /api/research/events?researchId=...&cursor=0
 *
 * Polling endpoint that returns events since the given cursor (sequence number).
 * Returns: { events: [...], cursor: nextCursor, status: "running" | "complete" | "error" }
 *
 * Client should poll every 500-1000ms until status is "complete" or "error".
 */
export async function researchEventsHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const researchId = url.searchParams.get("researchId");
  const cursor = parseInt(url.searchParams.get("cursor") || "0", 10);

  if (!researchId) {
    return new Response(JSON.stringify({ error: "researchId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = eventStores.get(researchId);

  // If no store exists yet, return empty with "pending" status
  if (!store) {
    return new Response(
      JSON.stringify({
        events: [],
        cursor: 0,
        status: "pending",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }

  // Get events since cursor
  const newEvents = store.events.filter((e) => e.seq >= cursor);
  const nextCursor = store.nextSeq;

  return new Response(
    JSON.stringify({
      events: newEvents,
      cursor: nextCursor,
      status: store.status,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
