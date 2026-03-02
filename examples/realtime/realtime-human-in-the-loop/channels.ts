import { realtime } from "inngest";
import { z } from "zod";

export const agenticWorkflowChannel = realtime.channel({
  name: "agentic-workflow",
  topics: {
    messages: {
      schema: z.object({
        message: z.string(),
        confirmationUUid: z.string(),
      }),
    },
  },
});
