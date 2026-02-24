import { realtime } from "inngest";
import { z } from "zod";

//
// Shared channel definitions — imported by both the function (to publish)
// and the subscriber (to subscribe). Types flow E2E.
export const uploads = realtime.channel({
  name: ({ uuid }: { uuid: string }) => `uploads:${uuid}`,
  topics: {
    status: {
      schema: z.object({
        message: z.string(),
        uploadId: z.string().optional(),
      }),
    },
    result: realtime.type<{ success: boolean; uploadId: string }>(),
  },
});
