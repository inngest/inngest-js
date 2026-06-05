import { inngest } from "./client.ts";

export const fn1 = inngest.createFunction(
  {
    id: "fn-1",
    retries: 0,
    triggers: { event: "event-1" },
  },
  async ({ step }) => {
    await step.run("a", () => {
      return "hi";
    });
  },
);
