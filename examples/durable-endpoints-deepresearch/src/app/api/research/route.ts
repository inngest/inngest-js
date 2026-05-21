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

import { step } from "inngest";
import { inngest } from "@/inngest/client";
import { NextRequest } from "next/server";
import type { AccumulatedResearch } from "@/inngest/types";
import { emitProgress } from "@/inngest/event-store";
import { maybeInjectFailure } from "@/inngest/utils";
import { generateSearchQueries, generateReport } from "@/inngest/llm";
import { deepResearch } from "@/inngest/deep-research";

export const GET = inngest.endpoint(async (req: NextRequest) => {
  const url = new URL(req.url);
  const researchId = url.searchParams.get("researchId");
  const topic = url.searchParams.get("topic");
  const clarificationsParam = url.searchParams.get("clarifications");
  const depth = parseInt(url.searchParams.get("depth") || "3", 10);
  const breadth = parseInt(url.searchParams.get("breadth") || "3", 10);

  // Failure injection params for durability demos
  const injectFailure = url.searchParams.get("injectFailure");
  const failureRate = parseFloat(url.searchParams.get("failureRate") || "0.3");

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
});
