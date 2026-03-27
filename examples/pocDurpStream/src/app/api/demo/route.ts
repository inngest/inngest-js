import Anthropic from "@anthropic-ai/sdk";
import { NonRetriableError, step } from "inngest";
import { stream } from "inngest/experimental/durable-endpoints";
import { inngest } from "@/inngest";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stream an Anthropic chat completion, pushing tokens to `stream` for the
 * client and returning the collected text.
 */
async function streamAndCollect(prompt: string): Promise<string> {
  const client = new Anthropic();
  const response = client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  response.on("text", (text) => stream.push(text));
  return await response.finalText();
}

export const GET = inngest.endpoint(async () => {
  const correlationId = await step.run("correlation-id", () =>
    crypto.randomUUID(),
  );

  const sentences = await step.run("first-llm", async () => {
    stream.push("👋 First, we'll generate some random text in English:\n");

    return streamAndCollect(
      "Write exactly two random sentences in English. No preamble, just the sentences. Put it in a single paragraph.",
    );
  });

  await step.run("language-prompt", () => {
    stream.push("\n🤔 What language should I translate to?\n");
    stream.push({ type: "await-input", correlationId });
  });

  const choice = await step.waitForEvent("wait-for-language", {
    event: "language-chosen",
    if: `async.data.correlationId == "${correlationId}"`,
    timeout: "60s",
  });

  if (!choice) {
    return "\n⌛ Timed out waiting for language choice.\n";
  }

  const language = choice.data.language as string;

  await step.run("second-llm", async () => {
    stream.push(`\n📚 Translating to ${language}:\n`);
    await sleep(300);

    if (language.toLowerCase() === "sindarin" && Math.random() < 0.1) {
      stream.push("🧙 ye shall not pass!\n");
      throw new Error("Ye shall not pass!");
    } else if (language.toLowerCase() === "dog") {
      throw new NonRetriableError("Dog Speak is Much Too Hard to Translate");
    }

    return streamAndCollect(
      `Translate the following text to ${language}. Output only the translation, no commentary.\n\n${sentences}`,
    );
  });

  if (language.toLowerCase() === "sindarin") {
    await Promise.all([
      step.run("sindarin-fist-bump", async () => {
        await sleep(300);
        stream.push("\nnerd cred 👊");
        return "you win the game";
      }),
      step.run("example-non-streamer", async () => {
        await sleep(3000);
        return "Did some processing!";
      }),
    ]);
  }

  return "\n🎉 We're all done here! Bye bye!";
});
