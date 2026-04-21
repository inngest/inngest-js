import { z } from "zod";
import { inngest } from "./client";

const myDefer = inngest.createDefer({
  handler: async ({ step }) => {
    await step.run("do-stuff", () => {
      console.log("Running myDefer");
      // Do stuff here
    });
  },
});

const myOtherDefer = inngest.createDefer({
  handler: async ({ step }) => {
    await step.run("do-other-stuff", () => {
      console.log("Running myOtherDefer");
      // Do other stuff here
    });
  },
});

export const fn = inngest.createFunction(
  {
    id: "my-fn",
    retries: 0,
    triggers: [{ event: "my-event" }],
    onDefer: {
      myDefer,
      myOtherDefer,
    },
  },
  async ({ defer, step }) => {
    const msg = await step.run("create-msg", async () => {
      await defer.myDefer("defer-1", {});
      return "hello from the main run";
    });

    await defer.myOtherDefer("defer-2", { msg });
  },
);
