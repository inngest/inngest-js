import { realtime, staticSchema } from "inngest";
import { z } from "zod";

//
// This example demonstrates the difference between runtime-validated schemas
// (Zod) and type-only schemas (staticSchema). Both provide full TypeScript
// type safety at compile time, but only Zod schemas validate data at runtime.

//
// Channel with a MIX of runtime-validated and type-only topics.
// This is the recommended pattern: use Zod for topics where you want runtime
// guarantees, and staticSchema for topics where types alone are sufficient.
export const pipeline = realtime.channel({
  name: ({ runId }: { runId: string }) => `pipeline:${runId}`,
  topics: {
    //
    // Runtime-validated topic (Zod) — invalid data is rejected at both
    // publish time (throws) and subscribe time (message dropped).
    status: {
      schema: z.object({
        message: z.string(),
        step: z.string().optional(),
      }),
    },

    //
    // Type-only topic (staticSchema) — full TypeScript type safety, but
    // no runtime validation. Invalid data passes through silently.
    // Use this when bundle size matters or when you trust the publisher.
    tokens: {
      schema: staticSchema<{ token: string; model?: string }>(),
    },
  },
});
