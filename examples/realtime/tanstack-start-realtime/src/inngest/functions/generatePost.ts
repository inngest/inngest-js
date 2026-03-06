import OpenAI from "openai";
import { inngest } from "../client";
import { contentPipeline } from "../channels";

const openai = new OpenAI();

const generateResearch = async (topic: string): Promise<string> => {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a research assistant. Provide concise research notes on the given topic. Include key facts, recent developments, and interesting angles for a blog post. Keep it under 500 words.",
      },
      { role: "user", content: `Research the following topic: ${topic}` },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
};

const generateOutline = async (
  topic: string,
  research: string,
): Promise<string> => {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a content strategist. Create a clear blog post outline with sections and bullet points. Keep it structured and actionable.",
      },
      {
        role: "user",
        content: `Create a blog post outline for "${topic}" based on this research:\n\n${research}`,
      },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
};

const generateDraftStream = async (topic: string, outline: string) => {
  const stream = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    stream: true,
    messages: [
      {
        role: "system",
        content:
          "You are a skilled blog writer. Write an engaging blog post following the provided outline. Use clear language and a conversational tone. Include a compelling introduction and conclusion.",
      },
      {
        role: "user",
        content: `Write a blog post about "${topic}" following this outline:\n\n${outline}`,
      },
    ],
  });
  return stream;
};

export const generatePost = inngest.createFunction(
  {
    id: "generate-post",
    triggers: [{ event: "app/generate-post" }],
  },
  async ({ event, step, publish }) => {
    const ch = contentPipeline({ runId: event.data.runId });

    //
    // Type safety — the channel schema enforces publish payloads at compile time.
    // Try uncommenting any of these to see TypeScript errors:

    // ❌ Wrong topic data shape — "message" must be a string, not a number:
    // await publish(ch.status, { message: 42 });

    // ❌ Missing required field — "artifact" requires kind, title, and body:
    // await publish(ch.artifact, { kind: "research", title: "Notes" });

    // ❌ Invalid enum value — kind must be "research" | "outline" | "draft":
    // await publish(ch.artifact, { kind: "summary", title: "X", body: "Y" });

    // ❌ Wrong topic — "ch.status" expects { message, step? }, not { token }:
    // await publish(ch.status, { token: "hello" });

    await publish(ch.status, {
      message: "Researching topic...",
      step: "research",
    });

    const research = await step.run("research", async () => {
      return await generateResearch(event.data.topic);
    });

    await step.realtime.publish("publish-research", ch.artifact, {
      kind: "research",
      title: "Research Notes",
      body: research,
    });

    await publish(ch.status, {
      message: "Creating outline...",
      step: "outline",
    });

    const outline = await step.run("outline", async () => {
      return await generateOutline(event.data.topic, research);
    });

    await step.realtime.publish("publish-outline", ch.artifact, {
      kind: "outline",
      title: "Post Outline",
      body: outline,
    });

    await publish(ch.status, {
      message: "Writing draft...",
      step: "draft",
    });

    const draft = await step.run("draft", async () => {
      const stream = await generateDraftStream(event.data.topic, outline);
      let fullText = "";
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content ?? "";
        if (token) {
          fullText += token;
          await publish(ch.tokens, { token });
        }
      }
      return fullText;
    });

    await step.realtime.publish("publish-draft", ch.artifact, {
      kind: "draft",
      title: "Final Draft",
      body: draft,
    });

    return { draft };
  },
);
