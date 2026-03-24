import { inngest } from "./client";

export const helloWorld = inngest.createFunction(
  {
    id: "hello-world",
    triggers: { event: "demo/event.sent" },
  },
  async ({ event, step }) => {
    const greeting = await step.run("greet", () => {
      return `Hello ${event.name}!`;
    });

    return { greeting };
  },
);
