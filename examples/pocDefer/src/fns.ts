import { inngest } from "./client";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const fn1 = inngest.createFunction(
  {
    id: "fn-1",
    checkpointing: false,
    retries: 0,
    triggers: [{ event: "event-1" }, { event: "deferred.start" }],
  },
  async ({ event, runId, step }) => {
    console.log(event.name, event.data);
    const output = await step.run("a", () => {
      console.log("step a");
      return "hi";
    });
    console.log(runId, output);

    if (event.name === "deferred.start") {
      await step.run("deferred-step", () => {
        console.log("deferred step");
      });
    } else {
      await step.sendEvent("defer", {
        name: "deferred.start",
        data: {
          runId,
          fnSlug: fn1.id(inngest.id),
        },
      });

      // Temporary to prevent race
      await sleep(1000);
    }
  },
);
