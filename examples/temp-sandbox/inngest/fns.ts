import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { inngest } from "./client.ts";

export const fn1 = inngest.createFunction(
  {
    id: "fn-1",
    retries: 0,
    triggers: { event: "event-1" },
  },
  async ({ event, step }) => {
    // step.run makes the call durable + memoized on retries. The AI SDK emits
    // its own ai.* spans because experimental_telemetry is enabled below and a
    // global provider is registered via --require ./instrumentation.cjs.
    const story = await step.run("generate", async () => {
      const { text } = await generateText({
        model: openai(event.data?.model ?? "gpt-5.4-nano"),
        prompt:
          event.data?.input ??
          "Write a one-sentence bedtime story about a unicorn.",
        experimental_telemetry: {
          isEnabled: true,
          recordInputs: true,
          recordOutputs: true,
        },
      });
      return text;
    });

    return { story };
  },
);
