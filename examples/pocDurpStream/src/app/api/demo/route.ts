import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getRunId, step, stream } from "inngest";
import { inngest } from "@/inngest";

/**
 * Stream a chat completion, piping tokens to `stream` for the client and
 * simultaneously collecting them into a string that is returned.
 *
 * Tries Anthropic first; falls back to OpenAI on billing/auth errors.
 */
async function streamAndCollect(prompt: string): Promise<string> {
  try {
    return await streamWithAnthropic(prompt);
  } catch (err: unknown) {
    const isBillingError =
      err instanceof Anthropic.APIError &&
      (err.status === 400 || err.status === 401 || err.status === 403);

    if (isBillingError) {
      console.warn(
        "Anthropic unavailable, falling back to OpenAI:",
        err.message,
      );
      return streamWithOpenAI(prompt);
    }

    throw err;
  }
}

async function streamWithAnthropic(prompt: string): Promise<string> {
  const client = new Anthropic();
  const anthropicStream = client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  return stream.pipe(async function* () {
    for await (const event of anthropicStream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
    yield "\n";
  });
}

async function streamWithOpenAI(prompt: string): Promise<string> {
  const client = new OpenAI();
  const openaiStream = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
    stream: true,
  });

  return stream.pipe(async function* () {
    for await (const chunk of openaiStream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) yield text;
    }
    yield "\n";
  });
}

export const GET = inngest.endpoint(async () => {
  const runId = await getRunId();
  if (!runId) {
    throw new Error("No runId in context");
  }

  const sentences = await step.run("first-llm", async () => {
    stream.push("👋 First, we'll generate some random text in English:\n");

    return streamAndCollect(
      "Write exactly 3 random sentences in English. No preamble, just the sentences. Put it in a single paragraph.",
    );
  });

  await step.run("language-prompt", () => {
    stream.push("\n🤔 What language should I translate to?\n");
  });

  const choice = await step.waitForEvent("wait-for-language", {
    event: "language-chosen",
    if: `async.data.runId == "${runId}"`,
    timeout: "60s",
  });

  if (!choice) {
    return "\n⌛ Timed out waiting for language choice.\n";
  }

  const language = choice.data.language as string;

  await step.run("second-llm", async () => {
    stream.push(`\n📚 Translating to ${language}:\n`);

    if (language === "Sindarin") {
      if (Math.random() < 0.1) {
        // Tweaking this probability is useful for reproducing retry behavior
        throw new Error("Suffer not ye nerd");
      }
    }

    return streamAndCollect(
      `Translate the following text to ${language}. Output only the translation, no commentary.\n\n${sentences}`,
    );
  });

  return "\n🎉 We're all done here! Bye bye!";
});
