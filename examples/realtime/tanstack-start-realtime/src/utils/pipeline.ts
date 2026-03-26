import { createServerFn } from "@tanstack/react-start";
import { getClientSubscriptionToken } from "inngest/react";
import { inngest } from "../inngest/client";
import { contentPipeline } from "../inngest/channels";

//
// Type safety -- getClientSubscriptionToken checks topic names against the channel.
// Try uncommenting this to see a TypeScript error for a non-existent topic:
// getClientSubscriptionToken(inngest, {
//   channel: contentPipeline({ runId: "test" }),
//   topics: ["status", "nonexistent"],
// });

export const getToken = createServerFn({ method: "GET" })
  .validator((input: { runId: string }) => input)
  .handler(async ({ data }) => {
    return getClientSubscriptionToken(inngest, {
      channel: contentPipeline({ runId: data.runId }),
      topics: ["status", "tokens", "artifact"],
    });
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
