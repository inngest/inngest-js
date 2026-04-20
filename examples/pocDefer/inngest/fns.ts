import { z } from "zod";
import { inngest } from "./client";

const myDefer = inngest.createDefer({
  handler: async ({ step }) => {
    await step.run("do-stuff", () => {
      // Do stuff here
    });
  },
});

const myOtherDefer = inngest.createDefer({
  handler: async ({ step }) => {
    await step.run("do-other-stuff", () => {
      // Do other stuff here
    });
  },
});

export const fn =  inngest.createFunction(
  {
    id: "my-fn",
    triggers: [{ event: "my-event" }],
    onDefer: {
      myDefer,
      myOtherDefer,
    },
  },
  async ({ defer, step }) => {
    const msg = await step.run("create-msg", () => {
      return "hello from the main run";
    });

    await defer.myDefer("defer-1", { msg });
    await defer.myOtherDefer("defer-2", { msg });
  },
);
