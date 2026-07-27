import { trace } from "@opentelemetry/api";

import { inngest } from "./client.ts";

const tracer = trace.getTracer("@opentelemetry/instrumentation-openai");

async function loadUserProfile() {
  return await tracer.startActiveSpan(
    "scratch.load-user-profile",
    {
      attributes: {
        "scratch.operation": "load-user-profile",
        "scratch.profile_id": "demo-user",
      },
    },
    async (span) => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        span.setAttribute("scratch.cache_hit", false);

        return { name: "Ada" };
      } finally {
        span.end();
      }
    },
  );
}

function simulateOpenAICall() {
  return tracer.startActiveSpan(
    "open-ai-span",
    {
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.4-nano",
        "gen_ai.response.finish_reasons": ["stop"],
        "gen_ai.response.id": "chatcmpl-scratch-example",
        "gen_ai.response.model": "gpt-5.4-nano-2026-03-17",
        "gen_ai.usage.input_tokens": 18,
        "gen_ai.usage.output_tokens": 39,
        "gen_ai.usage.total_tokens": 57,
      },
    },
    (span) => {
      span.end();
      return "done";
    },
  );
}

async function saveGeneratedMessage(message: string) {
  return await tracer.startActiveSpan(
    "scratch.save-generated-message",
    {
      attributes: {
        "scratch.message_length": message.length,
        "scratch.operation": "save-generated-message",
      },
    },
    async (span) => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        span.setAttribute("scratch.saved", true);

        return { saved: true };
      } finally {
        span.end();
      }
    },
  );
}

export const fn = inngest.createFunction(
  {
    id: "my-fn",
    retries: 0,
    triggers: { event: "my-event" },
  },
  async ({ step }) => {
    console.log("running");

    const profile = await step.run("load-user-profile", async () => {
      return await loadUserProfile();
    });

    const aiResult = await step.run("simulate-openai-call", () => {
      return simulateOpenAICall();
    });

    const saved = await step.run("save-generated-message", async () => {
      return await saveGeneratedMessage(aiResult);
    });

    return { aiResult, profile, saved };
  },
);
