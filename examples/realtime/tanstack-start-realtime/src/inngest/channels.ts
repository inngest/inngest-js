import { realtime } from "inngest";
import { z } from "zod";

export const contentPipeline = realtime.channel({
  name: ({ runId }: { runId: string }) => `pipeline:${runId}`,
  topics: {
    status: {
      schema: z.object({
        message: z.string(),
        step: z.string().optional(),
      }),
    },
    tokens: {
      schema: z.object({ token: z.string(), step: z.string() }),
    },
    artifact: {
      schema: z.object({
        kind: z.enum(["research", "outline", "draft"]),
        title: z.string(),
        body: z.string(),
      }),
    },
  },
});
