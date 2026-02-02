/**
 * LLM Integration for DeepResearch
 *
 * Uses Anthropic's Claude via the Vercel AI SDK for:
 * - Generating clarification questions
 * - Creating search queries with reasoning
 * - Extracting learnings from sources
 * - Generating final research reports
 */

import { anthropic } from "@ai-sdk/anthropic";
import { generateText, generateObject } from "ai";
import { z } from "zod";
import type {
  Source,
  AccumulatedResearch,
  QueryWithReasoning,
  ExtractedLearnings,
} from "./types";

// ============================================================
// ZOD SCHEMAS
// ============================================================

// Schema for clarification questions
export const ClarificationQuestionsSchema = z.object({
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

// Schema for search queries with reasoning
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

// Schema for extracted learnings
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

// ============================================================
// LLM FUNCTIONS
// ============================================================

/**
 * Generate clarification questions for a research topic
 */
export async function generateClarificationQuestions(topic: string) {
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
}

/**
 * Generate diverse search queries based on topic and user clarifications
 */
export async function generateSearchQueries(
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

/**
 * Extract key learnings from search results
 */
export async function extractLearnings(
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

/**
 * Generate a comprehensive research report with citations
 */
export async function generateReport(
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
