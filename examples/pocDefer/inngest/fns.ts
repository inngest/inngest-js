import { z } from "zod";
import { createDefer, createScorer } from "../../../packages/inngest/src/experimental.ts";
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

export const fn3 = inngest.createFunction(
  {
    id: "fn-3",
    triggers: { event: "fn-3.start" },
    retries: 0,
  },
  async ({ runId, step }) => {
    await step.run("my-step", async () => {
      await inngest.score({
        runId,
        stepId: "my-step",
        name: "answer_quality",
        // @ts-expect-error
        value: null,
      });
      await inngest.score({
        runId,
        stepId: "my-step",
        name: "latency_score",
        value: 20,
      });
    });
  },
);

export const fn4 = inngest.createFunction(
  {
    id: "fn-4",
    triggers: { event: "fn-4.start" },
    retries: 0,
  },
  async ({ runId, step }) => {
    for (let i = 1; i < 3; i++) {
      await step.run("my-step", async () => {
        await inngest.score({
          runId,
          stepId: "my-step",
          name: "answer_quality",
          value: 10 * i,
        });
        await inngest.score({
          runId,
          stepId: "my-step",
          name: "latency_score",
          value: 20 * i,
        });
      });
    }
  },
);

export const fn5 = inngest.createFunction(
  {
    id: "fn-5",
    triggers: { event: "fn-5.start" },
    retries: 0,
  },
  async ({ runId, step }) => {
    let stepId = "my-step-1"
    await step.run(stepId, async () => {
      await inngest.score({
        runId,
        stepId,
        name: "answer_quality",
        value: 10,
      });
      await inngest.score({
        runId,
        stepId,
        name: "latency_score",
        value: 20,
      });
    });

    stepId = "my-step-2"
    await step.run(stepId, async () => {
      await inngest.score({
        runId,
        stepId,
        name: "answer_quality",
        value: 20,
      });
      await inngest.score({
        runId,
        stepId,
        name: "latency_score",
        value: 40,
      });
    });
  },
);

export const scorer = createScorer(
  inngest,
  { id: "my-scorer", schema: z.object({ text: z.string() }) },
  async ({ event }) => {
    event.data.parent.fnSlug
    event.data.parent.runId
    console.log(event.data)
  }
)

export const foo = inngest.createFunction(
  {
    id: "foo",
    triggers: { event: "foo.start" },
    retries: 0,
  },
  async ({ defer, step }) => {
    defer("yo", { function: scorer, data: { text: "hello scorer!" } });
  }
)