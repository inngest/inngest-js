import { z } from "zod";
import { createDefer } from "../../../packages/inngest/src/experimental.ts";
import { inngest } from "./client";

const myDefer = createDefer(inngest, { id: "my-defer" }, async ({ step }) => {
  await step.run("do-stuff", () => {
    console.log("Running myDefer");
    // Do stuff here
  });
});

const myDefer2 = createDefer(
  inngest,
  { id: "my-defer-2" },
  async ({ step }) => {
    await step.run("do-other-stuff", () => {
      console.log("Running myOtherDefer");
      // Do other stuff here
    });
  },
);

export const fn = inngest.createFunction(
  {
    id: "my-fn",
    retries: 0,
    triggers: { event: "my-event" },
    onDefer: {
      myDefer,
      myDefer2,
    },
  },
  async ({ defer, step }) => {
    const msg = await step.run("create-msg", async () => {
      defer.myDefer("defer-1", {});
      return "hello from the main run";
    });

    defer.myDefer2("defer-2", { msg });
  },
);

export const fn2 = inngest.createFunction(
  {
    id: "my-fn-2",
    retries: 0,
    triggers: { event: "my-event-2" },
    onDefer: {
      myDefer,
      myDefer2,
    },
  },
  async ({ defer, step }) => {
    const msg = await step.run("create-msg", async () => {
      defer.myDefer("defer-1", {});
      return "hello from the main run";
    });

    defer.myDefer2("defer-2", { msg });
  },
);
