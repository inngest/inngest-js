import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("hit maxRuntime in stepless function", async () => {
  // We created this test after discovering a bug. The SDK returned a response
  // but kept processing the function, resulting in duplicate execution
  // requests.

  const state = createState({ enterCount: 0 });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
      checkpointing: {
        maxRuntime: 1,
      },
    },
    async ({ runId }) => {
      state.runId = runId;
      state.enterCount++;
      await sleep(2000);
      return "done";
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();

  expect(result).toBe("done");
  expect(state.enterCount).toBe(1);
});

test("hit maxRuntime between steps", async () => {
  // We created this test after discovering a bug. The SDK returned a response
  // but kept processing the function, resulting in duplicate execution
  // requests.

  const state = createState({ enterCount: 0 });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
      checkpointing: {
        maxRuntime: 1,
      },
    },
    async ({ runId, step }) => {
      state.runId = runId;
      state.enterCount++;
      await step.run("before", async () => {});
      await sleep(2000);
      await step.run("after", async () => {});
      return "done";
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();

  expect(result).toBe("done");
  expect(state.enterCount).toBe(3);
});

test("hit maxRuntime after step", async () => {
  // We created this test after discovering a bug. The SDK returned a response
  // but kept processing the function, resulting in duplicate execution
  // requests.

  const state = createState({ enterCount: 0 });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
      checkpointing: {
        maxRuntime: 1,
      },
    },
    async ({ runId, step }) => {
      state.runId = runId;
      state.enterCount++;
      await step.run("before", async () => {});
      await sleep(2000);
      return "done";
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();

  expect(result).toBe("done");
  expect(state.enterCount).toBe(1);
});
