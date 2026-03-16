import Anthropic from "@anthropic-ai/sdk";
import { step, stream } from "inngest";
import { inngest } from "@/inngest";

/**
 * Stream an Anthropic chat completion, piping tokens to `stream` for the
 * client and simultaneously collecting them into a string that is returned.
 */
async function streamAndCollect(prompt: string): Promise<string> {
  const client = new Anthropic();

  return stream.pipe(async function* () {
    const anthropicStream = client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

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

export const GET = inngest.endpoint(async () => {
  const correlationId = await step.run("correlation-id", () =>
    crypto.randomUUID()
  );

  const sentences = await step.run("first-llm", async () => {
    stream.push("👋 First, we'll generate some random text in English:\n");

    return streamAndCollect(
      "Write exactly 5 random sentences in English. No preamble, just the sentences. Put it in a single paragraph.",
    );
  });

  await step.run("language-prompt", () => {
    stream.push("\n🤔 What language should I translate to?\n");
    stream.push(
      JSON.stringify({ type: "await-input", correlationId }) + "\n"
    );
  });

  const choice = await step.waitForEvent("wait-for-language", {
    event: "language-chosen",
    if: `async.data.correlationId == "${correlationId}"`,
    timeout: "60s",
  });

  if (!choice) {
    return "\n⌛️ Timed out waiting for language choice.\n";
  }

  const language = choice.data.language as string;

  await step.run("second-llm", async () => {
    stream.push(`\n📚 Translating to ${language}:\n`);

    return streamAndCollect(
      `Translate the following text to ${language}. Output only the translation, no commentary.\n\n${sentences}`,
    );
  });

  return "\n🎉 We're all done here! Bye bye!";
});
