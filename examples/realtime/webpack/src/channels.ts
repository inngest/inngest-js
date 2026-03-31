import { realtime, staticSchema } from "inngest/realtime";
import { z } from "zod";

//
// Channel using staticSchema
export const staticChannel = realtime.channel({
  name: ({ chatUrn }: { chatUrn: string }) => chatUrn,
  topics: {
    status: {
      schema: staticSchema<{ status: string }>(),
    },
  },
});

//
// Channel using zod
export const zodChannel = realtime.channel({
  name: ({ chatUrn }: { chatUrn: string }) => chatUrn,
  topics: {
    status: {
      schema: z.object({ status: z.string() }),
    },
  },
});
