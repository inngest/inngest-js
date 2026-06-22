/**
 * GET /api/research/clarify?topic=...
 *
 * Generate clarification questions for a research topic.
 * This is a Durable Endpoint - the LLM call is wrapped in step.run()
 * for automatic retries on failure.
 */

import { step } from "inngest";
import { inngest } from "@/inngest/client";
import { NextRequest } from "next/server";
import { generateClarificationQuestions } from "@/inngest/llm";

export const GET = inngest.endpoint(async (req: NextRequest) => {
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
});
