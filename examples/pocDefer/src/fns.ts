import { inngest } from "./client";

export const fn1 = inngest.createFunction(
  {
    id: "fn-1",
    checkpointing: false,
    retries: 0,
    triggers: [{ event: "event-1" }],
  },
  async ({ event, runId, step, group }) => {
    console.log(event.name, event.data);
    const output = await step.run("a", () => {
      console.log("step a");
      return "hi";
    });
    console.log(runId, output);

    await group.defer(async () => {
      await step.run("deferred-step", () => {
        console.log("deferred step");
      });
    });
  },
);
