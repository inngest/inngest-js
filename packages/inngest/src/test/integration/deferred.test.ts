import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("group.defer() runs callback in a separate deferred run", async () => {
  const deferredRun = createState({});
  const parentRun = createState({});

  const steps = {
    insideDefer: {
      count: 0,
      outputs: [] as string[],
    },
    outsideDefer: {
      count: 0,
      outputs: [] as string[],
    },
  };

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    checkpointing: false,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ event, runId, step, group }) => {
      const output = await step.run("outside-defer", () => {
        steps.outsideDefer.count++;
        return "outside-defer";
      });
      steps.outsideDefer.outputs.push(output);

      if (event.name === "deferred.start") {
        deferredRun.runId = runId;
      } else {
        parentRun.runId = runId;
      }

      await group.defer(async () => {
        const output = await step.run("inside-defer", () => {
          steps.insideDefer.count++;
          return "inside-defer";
        });
        steps.insideDefer.outputs.push(output);
      });
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  await parentRun.waitForRunComplete();

  await deferredRun.waitForRunComplete();

  expect(steps).toEqual({
    insideDefer: {
      count: 1,
      outputs: ["inside-defer"],
    },
    outsideDefer: {
      count: 1,
      outputs: [
        "outside-defer",
        "outside-defer",
        "outside-defer",
        "outside-defer",
      ],
    },
  });
});
