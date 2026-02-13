import { inngest } from "./inngest";

export const simpleSleepFunction = inngest.createFunction(
  { id: "simple-sleep-function", triggers: [{ event: "demo/simple.sleep" }] },
  async ({ step }) => {
    await step.sleep("wait-10s", "5s");
    return { message: "Function completed after 5 seconds!" };
  }
);

export const multiStepStreamingFunction = inngest.createFunction(
  { id: "multi-step-streaming-function", triggers: [{ event: "demo/multistep.start" }] },
  async ({ step, publish, event }) => {
    await publish({
      channel: `multi-step-streaming-function.${event.data.uuid}`,
      topic: "updates",
      data: {
        message: "multi-step-streaming-function started!",
      },
    });

    await step.sleep("step-1-sleep", "5s");
    await publish({
      channel: `multi-step-streaming-function.${event.data.uuid}`,
      topic: "updates",
      data: {
        message: "Step 1 completed after 5 seconds!",
      },
    });

    await step.sleep("step-2-sleep", "2s");
    await publish({
      channel: `multi-step-streaming-function.${event.data.uuid}`,
      topic: "updates",
      data: {
        message: "Step 2 completed after 2 seconds!",
      },
    });
    await step.sleep("step-3-sleep", "4s");
    await publish({
      channel: `multi-step-streaming-function.${event.data.uuid}`,
      topic: "updates",
      data: {
        message: "Step 3 completed after 4 seconds!",
      },
    });
    await step.sleep("step-5-sleep", "1s");
    await publish({
      channel: `multi-step-streaming-function.${event.data.uuid}`,
      topic: "updates",
      data: {
        message: "All steps completed!",
        done: true,
      },
    });
    return { message: "All steps completed!" };
  }
);

export const failingFunction = inngest.createFunction(
  { id: "failing-function", retries: 1, triggers: [{ event: "demo/failing.function" }] },
  async ({ step }) => {
    // first step sleeps for 5 seconds
    await step.sleep("wait-5s", "5s");

    // second step fails
    await step.run("Failing step", async () => {
      throw new Error("This step always fails!");
    });
    return "done";
  }
);

export const throttledFunction = inngest.createFunction(
  {
    id: "throttled-function",
    throttle: {
      limit: 2,
      period: "2s",
    },
    triggers: [{ event: "demo/throttled.function" }],
  },
  async ({ step }) => {
    // first step sleeps for 1 second
    await step.sleep("wait-1s", "1s");

    return "done";
  }
);
