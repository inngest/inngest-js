import { inngest } from "./client";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const helloWorld = inngest.createFunction(
  { id: "hello-world" },
  { event: "demo/event.sent" },
  async ({ event, step }) => {
    const results = await Promise.all([
      // 1s
      step.run("foo", async () => {
        await wait(1000);

        return "I did foo";
      }),

      // 10
      step.run("bar", async () => {
        await wait(5000);

        return "I did bar";
      }),
    ]);

    return {
      results,
      message: `Hello ${event.name}!`,
    };
  },
);
