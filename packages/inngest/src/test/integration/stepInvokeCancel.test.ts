import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { z } from "zod";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("step.invoke throws NonRetriableError when invoked function is cancelled", async () => {
  const state = createState({
    caughtError: null as unknown,
  });

  const cancelEvent = randomSuffix("cancel");
  const childTrigger = randomSuffix("child");
  const parentTrigger = randomSuffix("parent");

  const inngest = new Inngest({ id: randomSuffix(testFileName), isDev: true });

  const child = inngest.createFunction(
    {
      id: "child",
      cancelOn: [{ event: cancelEvent }],
      triggers: [{ event: childTrigger, schema: z.object({}) }],
    },
    async ({ step }) => {
      await step.sleep("sleep", 60_000);
      return { text: "hello world" };
    },
  );

  const parent = inngest.createFunction(
    {
      id: "parent",
      triggers: [{ event: parentTrigger, schema: z.object({}) }],
    },
    async ({ step, runId }) => {
      state.runId = runId;
      try {
        await Promise.all([
          step.invoke("invoke child", { function: child, data: {} }),
          step.sendEvent("cancel child", { name: cancelEvent, data: {} }),
        ]);
      } catch (err) {
        state.caughtError = err;
      }
    },
  );

  await createTestApp({
    client: inngest,
    functions: [parent, child],
    serve: createServer,
  });

  await inngest.send({ name: parentTrigger, data: {} });
  await state.waitForRunComplete();

  expect(state.caughtError).toBeDefined();
  expect((state.caughtError as Error).name).toBe("NonRetriableError");
  expect((state.caughtError as Error).message).toBe(
    "Invoked function was cancelled",
  );
});

test("step.invoke causes run to fail when cancelled and unhandled", async () => {
  const state = createState({});

  const cancelEvent = randomSuffix("cancel-unhandled");
  const childTrigger = randomSuffix("child-unhandled");
  const parentTrigger = randomSuffix("parent-unhandled");

  const inngest = new Inngest({ id: randomSuffix(testFileName), isDev: true });

  const child = inngest.createFunction(
    {
      id: "child-unhandled",
      cancelOn: [{ event: cancelEvent }],
      triggers: [{ event: childTrigger, schema: z.object({}) }],
    },
    async ({ step }) => {
      await step.sleep("sleep", 60_000);
      return { text: "hello world" };
    },
  );

  const parent = inngest.createFunction(
    {
      id: "parent-unhandled",
      triggers: [{ event: parentTrigger, schema: z.object({}) }],
    },
    async ({ step, runId }) => {
      state.runId = runId;
      await Promise.all([
        step.invoke("invoke child", { function: child, data: {} }),
        step.sendEvent("cancel child", { name: cancelEvent, data: {} }),
      ]);
    },
  );

  await createTestApp({
    client: inngest,
    functions: [parent, child],
    serve: createServer,
  });

  await inngest.send({ name: parentTrigger, data: {} });
  await state.waitForRunFailed();
});

test("step.invoke returns data when invoked function succeeds", async () => {
  const state = createState({
    result: null as unknown,
  });

  const childTrigger = randomSuffix("child-succ");
  const parentTrigger = randomSuffix("parent-succ");

  const inngest = new Inngest({ id: randomSuffix(testFileName), isDev: true });

  const child = inngest.createFunction(
    {
      id: "child-succ",
      triggers: [{ event: childTrigger, schema: z.object({}) }],
    },
    async () => {
      return { text: "hello world" };
    },
  );

  const parent = inngest.createFunction(
    {
      id: "parent-succ",
      triggers: [{ event: parentTrigger, schema: z.object({}) }],
    },
    async ({ step, runId }) => {
      state.runId = runId;
      const result = await step.invoke("invoke child", {
        function: child,
        data: {},
      });
      state.result = result;
    },
  );

  await createTestApp({
    client: inngest,
    functions: [parent, child],
    serve: createServer,
  });

  await inngest.send({ name: parentTrigger, data: {} });
  await state.waitForRunComplete();

  expect(state.result).toEqual({ text: "hello world" });
});
