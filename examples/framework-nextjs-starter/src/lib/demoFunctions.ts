import { inngest } from "./inngest";

export const simpleSleepFunction = inngest.createFunction(
  { id: "simple-sleep-function" },
  { event: "demo/simple.sleep" },
  async ({ step }) => {
    await step.sleep("wait-10s", "5s");
    return { message: "Function completed after 5 seconds!" };
  }
);

export const multiStepStreamingFunction = inngest.createFunction(
  { id: "multi-step-streaming-function" },
  { event: "demo/multistep.start" },
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
