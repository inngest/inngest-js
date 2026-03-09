import OpenAI from "openai";
import { inngest } from "../client";
import { contentPipeline } from "../channels";

const openai = new OpenAI();

export const generatePost = inngest.createFunction(
  {
    id: "generate-post",
    triggers: [{ event: "app/generate-post" }],
  },
  async ({ event, step }) => {
    const ch = contentPipeline({ runId: event.data.runId });

    //
    // Type safety — the channel schema enforces publish payloads at compile time.
    // Try uncommenting any of these to see TypeScript errors:

    // ❌ Wrong topic data shape — "message" must be a string, not a number:
    // await inngest.publish(ch.status, { message: 42 });

    // ❌ Missing required field — "artifact" requires kind, title, and body:
    // await inngest.publish(ch.artifact, { kind: "research", title: "Notes" });

    // ❌ Invalid enum value — kind must be "research" | "outline" | "draft":
    // await inngest.publish(ch.artifact, { kind: "summary", title: "X", body: "Y" });

    // ❌ Wrong topic — "ch.status" expects { message, step? }, not { token }:
    // await inngest.publish(ch.status, { token: "hello" });

    const streamLLM = async (
      system: string,
      prompt: string,
      stepName: string,
    ) => {
      const stream = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      });
      let fullText = "";
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content ?? "";
        if (token) {
          fullText += token;
          //
          // Non-durable publish via the client — fine for high-frequency
          // streaming where duplicates on retry are harmless.
          await inngest.publish(ch.tokens, { token, step: stepName });
        }
      }
      return fullText;
    };

    await step.realtime.publish("status-research", ch.status, {
      message: "Researching topic...",
      step: "research",
    });

    const research = await step.run("research", () =>
      streamLLM(
        "You are a research assistant. Provide concise research notes on the given topic. Include key facts, recent developments, and interesting angles for a blog post. Keep it under 500 words.",
        `Research the following topic: ${event.data.topic}`,
        "research",
      ),
    );

    await step.realtime.publish("artifact-research", ch.artifact, {
      kind: "research",
      title: "Research Notes",
      body: research,
    });

    await step.realtime.publish("status-outline", ch.status, {
      message: "Creating outline...",
      step: "outline",
    });

    const outline = await step.run("outline", () =>
      streamLLM(
        "You are a content strategist. Create a clear blog post outline with sections and bullet points. Keep it structured and actionable.",
        `Create a blog post outline for "${event.data.topic}" based on this research:\n\n${research}`,
        "outline",
      ),
    );

    await step.realtime.publish("artifact-outline", ch.artifact, {
      kind: "outline",
      title: "Post Outline",
      body: outline,
    });

    await step.realtime.publish("status-draft", ch.status, {
      message: "Writing draft...",
      step: "draft",
    });

    const draft = await step.run("draft", () =>
      streamLLM(
        "You are a skilled blog writer. Write an engaging blog post following the provided outline. Use clear language and a conversational tone. Include a compelling introduction and conclusion.",
        `Write a blog post about "${event.data.topic}" following this outline:\n\n${outline}`,
        "draft",
      ),
    );

    await step.realtime.publish("artifact-draft", ch.artifact, {
      kind: "draft",
      title: "Final Draft",
      body: draft,
    });

    return { draft };
  },
);
