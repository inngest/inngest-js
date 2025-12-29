import { inngest } from "./client";
import { cron, invoke } from "inngest/experimental";
import { z } from "zod";
import { event1, event2, event3 } from "./types";

export default inngest.createFunction(
  { id: "hello-world" },
  [event1, cron("* * * * *"), invoke(z.object({ message: z.string() }))],
  async ({ event, step }) => {
    await step.sendEvent("good", [
      event2.create({}),
      event2.create({ data: { message: "Hello from event-2" } }),
      event3.create({ data: { message: "Hello from event-3" } }),
    ]);

    await step.sendEvent("bad", [
      // @ts-expect-error - Missing data
      event3.create(),

      // @ts-expect-error - Invalid data
      event3.create({ data: { bad: "oh no" } }),
    ]);

    return {
      message: `Hello ${event.name}!`,
    };
  }
);
