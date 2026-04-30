import { z } from "zod";
import { createDefer } from "../../../packages/inngest/src/experimental.ts";
import { inngest } from "./client";

export const myDefer = createDefer(
  inngest,
  { id: "my-defer" },
  async ({ step }) => {
    await step.run("do-stuff", () => {
      console.log("Running myDefer");
      // Do stuff here
    });
  },
);

export const myDefer2 = createDefer(
  inngest,
  { id: "my-defer-2", schema: z.object({ msg: z.string() }) },
  async ({ event, step }) => {
    await step.run("do-other-stuff", () => {
      console.log("Running myOtherDefer", event.data.msg);
      // Do other stuff here
    });
  },
);

export const fn = inngest.createFunction(
  {
    id: "my-fn",
    retries: 0,
    triggers: { event: "my-event" },
  },
  async ({ defer, step }) => {
    const msg = await step.run("create-msg", async () => {
      defer("defer-1", { function: myDefer, data: {} });
      return "hello from the main run";
    });

    defer("defer-2", { function: myDefer2, data: { msg } });
  },
);

export const fn2 = inngest.createFunction(
  {
    id: "my-fn-2",
    retries: 0,
    triggers: { event: "my-event-2" },
  },
  async ({ defer, step }) => {
    const msg = await step.run("create-msg", async () => {
      defer("defer-1", { function: myDefer, data: {} });
      return "hello from the main run";
    });

    defer("defer-2", { function: myDefer2, data: { msg } });
  },
);
