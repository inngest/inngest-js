import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import OpenAI from "openai";
import { inngest } from "./client.ts";

const openaiClient = new OpenAI();

export const fn1 = inngest.createFunction(
  {
    id: "fn-1",
    retries: 0,
    triggers: { event: "event-1" },
    checkpointing: false,
  },
  async ({ event, step }) => {
    // step.run makes the call durable + memoized on retries. AI spans come from
    // the AI SDK telemetry flag or the OpenAI instrumentation preloaded via
    // --require ./instrumentation.cjs.
    // await step.run("lib-ai", async () => {
    //   const { text } = await generateText({
    //     model: openai("gpt-5.4-nano"),
    //     prompt: "Write a one-sentence bedtime story about a unicorn.",
    //     experimental_telemetry: {
    //       isEnabled: true,
    //       recordInputs: true,
    //       recordOutputs: true,
    //     },
    //   });
    //   return text;
    // });

    await step.run("lib-openai", async () => {
      const response = await openaiClient.chat.completions.create({
        model: "gpt-5.4-nano",
        messages: [
          {
            role: "user",
            content: "Write a one-sentence bedtime story about a sleepy robot.",
          },
        ],
        max_completion_tokens: 80,
      });

      return response.choices[0]?.message.content ?? "";
    });
  },
);
