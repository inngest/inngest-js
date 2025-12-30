import { inngest } from "./client";
import { cron, invoke } from "inngest/experimental";
import { z } from "zod";
import { event1, event2, event3 } from "./types";

export default inngest.createFunction(
  { id: "hello-world" },
  [
    event1,
    cron("* * * * *"),
    invoke(z.object({ message: z.string() })),
  ] as const,
  async ({ event, step }) => {
    await step.sendEvent("good", [
      event2.create({}),
      event2.create({ data: { message: "Hello from event-2" } }),
      event3.create({ data: { message: "Hello from event-3" } }),
    ]);

    return {
      message: `Hello ${event.name}!`,
    };
  }
);
