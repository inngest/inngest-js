import { realtime } from "inngest";
import { z } from "zod";

export const globalChannel = realtime.channel({
  name: "global",
  topics: {
    logs: { schema: z.string() },
  },
});

export const postChannel = realtime.channel({
  name: ({ postId }: { postId: string }) => `post:${postId}`,
  topics: {
    updated: {
      schema: z.object({
        id: z.string(),
        likes: z.number(),
      }),
    },
    deleted: {
      schema: z.object({
        id: z.string(),
        reason: z.string(),
      }),
    },
  },
});
