import { inngest } from "./client";

export default inngest.createFunction(
  { id: "hello-world" },
  { event: "demo/event.sent" },
  async ({ event, step }) => {
    const result = await step.waitForSignal("wait-for-it", {
      signal: "hmm",
      timeout: "5m"
    })

    return {
      result,
      message: `Hello ${event.name}!`,
    };
  }
);
