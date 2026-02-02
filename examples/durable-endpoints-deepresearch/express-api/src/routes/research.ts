/**
 * DeepResearch Durable Endpoints
 *
 * This file contains the HTTP handlers for the DeepResearch API.
 * All handlers are wrapped with inngest.endpoint() to make them durable.
 *
 * Endpoints:
 * - GET /api/research/clarify - Generate clarification questions
 * - GET /api/research - Execute deep research workflow
 * - GET /api/research/events - Poll for progress events
 */

import { Inngest, step } from "inngest";
import { endpointAdapter } from "inngest/edge";

// Import from modular files
import type { AccumulatedResearch } from "./types";
import { emitProgress, getEventsSinceCursor } from "./event-store";
import { maybeInjectFailure } from "./utils";
import {
  generateClarificationQuestions,
  generateSearchQueries,
  generateReport,
} from "./llm";
import { deepResearch } from "./deep-research";

// Re-export types for consumers
export type { ResearchEvent, Source, AccumulatedResearch } from "./types";

// Initialize Inngest client with the edge adapter for durable endpoints
const inngest = new Inngest({ id: "deepresearch-backend", endpointAdapter });

// ============================================================
// CLARIFICATION ENDPOINT
// ============================================================

/**
 * GET /api/research/clarify?topic=...
 *
 * Generate clarification questions for a research topic.
 * This is a Durable Endpoint - the LLM call is wrapped in step.run()
 * for automatic retries on failure.
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

    // Durable step: Generate clarification questions with automatic retry
    const questions = await step.run("generate-clarifications", async () => {
      return await generateClarificationQuestions(topic);
    });

    console.log(`[Clarify] Generated ${questions.length} questions`);

    return new Response(JSON.stringify({ questions }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
);

// ============================================================
// RESEARCH ENDPOINT
// ============================================================

/**
 * GET /api/research?researchId=...&topic=...&clarifications=...&depth=...&breadth=...
 *
 * The main durable endpoint that executes the deep research workflow.
 *
 * Query Parameters:
 * - researchId: Unique ID for this research session (required)
 * - topic: The research topic (required)
 * - clarifications: JSON-encoded object of user answers (optional)
 * - depth: Number of recursive depth levels (default: 3)
 * - breadth: Number of queries per level (default: 3)
 * - injectFailure: Step type to inject failures into for demos ("search" | "learn" | "report")
 * - failureRate: Probability of failure injection (0.0-1.0, default: 0.3)
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
    const injectFailure = url.searchParams.get("injectFailure");
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

    // Initialize accumulated research state
    const accumulated: AccumulatedResearch = {
      topic,
      sources: [],
      learnings: [],
      queries: [],
    };
    const existingUrls = new Set<string>();

    try {
      // ─────────────────────────────────────────────────────────
      // Step 1: Generate initial search queries
      // ─────────────────────────────────────────────────────────
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

      // ─────────────────────────────────────────────────────────
      // Step 2: Execute recursive deep research
      // ─────────────────────────────────────────────────────────
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

      // ─────────────────────────────────────────────────────────
      // Step 3: Generate final report
      // ─────────────────────────────────────────────────────────
      emitProgress(researchId, {
        type: "report-generating",
        progress: 95,
        reasoning: "Synthesizing findings into a comprehensive report...",
      });

      const report = await step.run("generate-report", async () => {
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
// EVENTS POLLING ENDPOINT
// ============================================================

/**
 * GET /api/research/events?researchId=...&cursor=0
 *
 * Polling endpoint that returns events since the given cursor.
 * Client should poll every 500-1000ms until status is "complete" or "error".
 *
 * Returns:
 * - events: Array of new events since cursor
 * - cursor: Next cursor value to use
 * - status: "pending" | "running" | "complete" | "error"
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

  const result = getEventsSinceCursor(researchId, cursor);

  // If no store exists yet, return empty with "pending" status
  if (!result) {
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

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
