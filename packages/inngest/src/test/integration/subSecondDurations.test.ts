import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("step.sleep with a 500ms numeric duration rounds up and sleeps 1s", async () => {
  // Sub-second numeric durations used to serialize to "" (floored to whole
  // seconds), which the server treated as a 0-duration sleep. They now round
  // up to 1s, the wire format's resolution.

  const state = createState({ beforeSleep: 0, afterSleep: 0 });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId, step }) => {
      state.runId = runId;
      state.beforeSleep ||= Date.now();
      await step.sleep("sleep", 500);
      state.afterSleep ||= Date.now();
      return "done";
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();

  expect(result).toBe("done");
  const elapsed = state.afterSleep - state.beforeSleep;
  expect(elapsed).toBeGreaterThanOrEqual(900);
});

test("step.sleep with a 1500ms numeric duration floors to 1s", async () => {
  // Durations of at least 1s floor to whole seconds, matching long-standing
  // behavior; only purely sub-second durations round up.

  const state = createState({ beforeSleep: 0, afterSleep: 0 });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId, step }) => {
      state.runId = runId;
      state.beforeSleep ||= Date.now();
      await step.sleep("sleep", 1500);
      state.afterSleep ||= Date.now();
      return "done";
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();

  expect(result).toBe("done");
  const elapsed = state.afterSleep - state.beforeSleep;
  expect(elapsed).toBeGreaterThanOrEqual(900);
});

test("step.waitForEvent with a sub-second numeric timeout times out with null", async () => {
  const state = createState<{ waitResult: unknown }>({ waitResult: "unset" });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId, step }) => {
      state.runId = runId;
      state.waitResult = await step.waitForEvent("wait", {
        event: randomSuffix("never"),
        timeout: 500,
      });
      return "done";
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();

  expect(result).toBe("done");
  expect(state.waitResult).toBeNull();
});
