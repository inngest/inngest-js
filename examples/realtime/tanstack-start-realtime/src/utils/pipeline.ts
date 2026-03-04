import { createServerFn } from "@tanstack/react-start";
import { getSubscriptionToken } from "inngest/react";
import { inngest } from "../inngest/client";
import { contentPipeline } from "../inngest/channels";

//
// Type safety — getSubscriptionToken checks topic names against the channel.
// Try uncommenting this to see a TypeScript error for a non-existent topic:
// getSubscriptionToken(inngest, {
//   channel: contentPipeline({ runId: "test" }),
//   topics: ["status", "nonexistent"],
// });

export const getToken = createServerFn({ method: "GET" })
  .validator((input: { runId: string }) => input)
  .handler(async ({ data }) => {
    const token = await getSubscriptionToken(inngest, {
      channel: contentPipeline({ runId: data.runId }),
      topics: ["status", "tokens", "artifact"],
    });
    if (!token.key) {
      throw new Error("No realtime token returned");
    }
    return token.key;
  });

export const startPipeline = createServerFn({ method: "POST" })
  .validator((input: { topic: string }) => input)
  .handler(async ({ data }) => {
    const runId = crypto.randomUUID();
    await inngest.send({
      name: "app/generate-post",
      data: { topic: data.topic, runId },
    });
    return { runId };
  });
