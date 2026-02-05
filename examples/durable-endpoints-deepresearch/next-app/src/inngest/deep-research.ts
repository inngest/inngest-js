/**
 * Deep Research Algorithm
 *
 * Implements recursive, parallel research exploration using Inngest's
 * durable step functions. Each search and learning extraction is wrapped
 * in step.run() for automatic retries and memoization.
 */

import { step } from "inngest";
import type {
  Source,
  AccumulatedResearch,
  QueryInput,
  QueryWithReasoning,
} from "./types";
import { emitProgress } from "./event-store";
import { hashQuery, calculateProgress, maybeInjectFailure } from "./utils";
import { searchExa } from "./search";
import { extractLearnings } from "./llm";

/**
 * Recursive deep research function with parallel execution
 *
 * At each depth level:
 * 1. Searches all queries in parallel using Promise.all
 * 2. Extracts learnings from results in parallel
 * 3. Collects follow-up queries and recurses to next depth
 *
 * Each step.run() is individually durable - Inngest automatically retries
 * on failure and memoizes results for replay.
 */
export async function deepResearch(
  researchId: string,
  topic: string,
  queries: QueryInput[],
  depth: number,
  maxDepth: number,
  breadth: number,
  accumulated: AccumulatedResearch,
  existingUrls: Set<string>,
  injectFailure: string | null = null,
  failureRate: number = 0.3
): Promise<AccumulatedResearch> {
  // Base case: no more depth or queries
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

  // ─────────────────────────────────────────────────────────────
  // Step 1: Search all queries in parallel
  // Each step.run() returns data; processing happens outside for
  // proper memoization (side effects don't replay)
  // ─────────────────────────────────────────────────────────────
  const searchResults = await Promise.all(
    queries.map((queryInput) => {
      const query =
        typeof queryInput === "string" ? queryInput : queryInput.query;
      const stepHash = hashQuery(query);

      return step.run(`search-d${depth}-${stepHash}`, async () => {
        maybeInjectFailure("search", injectFailure, failureRate);
        const results = await searchExa(query);
        return { query, results };
      });
    })
  );

  // Process search results outside steps (runs on every replay)
  const queryResults: Array<{ query: string; newResults: Source[] }> = [];

  for (const { query, results } of searchResults) {
    // Filter out duplicate URLs
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

  // ─────────────────────────────────────────────────────────────
  // Step 2: Extract learnings from all results in parallel
  // ─────────────────────────────────────────────────────────────
  const learningsResults = await Promise.all(
    queryResults.map(({ query, newResults }) => {
      const stepHash = hashQuery(query);

      return step.run(`learn-d${depth}-${stepHash}`, async () => {
        maybeInjectFailure("learn", injectFailure, failureRate);
        const learnings = await extractLearnings(
          topic,
          query,
          newResults,
          accumulated.learnings
        );
        return { query, learnings };
      });
    })
  );

  // Process learnings outside steps (runs on every replay)
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
      } as QueryWithReasoning);
    }
  }

  emitProgress(researchId, {
    type: "depth-complete",
    depth,
    progress: calculateProgress(depth - 1, maxDepth, 0, 1),
    reasoning: `Completed depth ${maxDepth - depth + 1}/${maxDepth}`,
  });

  // ─────────────────────────────────────────────────────────────
  // Step 3: Recurse with follow-up queries
  // ─────────────────────────────────────────────────────────────
  if (allFollowUps.length > 0 && depth > 1) {
    const nextBreadth = Math.ceil(breadth / 2);
    // Limit follow-ups to prevent explosion
    const limitedFollowUps = allFollowUps.slice(
      0,
      nextBreadth * queries.length
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
      failureRate
    );
  }

  return accumulated;
}
