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

/**
 * End-to-end: main function calls `group.defer.analytics(...)`. The executor
 * must emit `OpcodeDeferAdd` → persist a Defer record → call `finalizeDefers`
 * after the main run completes → dispatch `inngest/deferred.start` → route to
 * the synthetic defer function → unwrap `event.data.input` into `ctx.data`.
 */
test("group.defer dispatches deferred handler with user input", async () => {
  const state = createState({
    mainCompleted: false,
    deferReached: false,
    capturedData: undefined as Record<string, unknown> | undefined,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      triggers: [{ event: eventName }],
      retries: 0,
      onDefer: {
        analytics: {
          handler: async ({ data }) => {
            state.deferReached = true;
            state.capturedData = data;
          },
        },
      },
    },
    async ({ group, runId }) => {
      state.runId = runId;
      await group.defer.analytics("defer-analytics", {
        orderId: "abc-123",
        amount: 42,
      });
      state.mainCompleted = true;
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ data: {}, name: eventName });

  await state.waitForRunComplete();

  // The deferred handler fires after finalize, so poll for it.
  await waitFor(() => {
    expect(state.deferReached).toBe(true);
  });

  expect(state.mainCompleted).toBe(true);
  expect(state.capturedData).toEqual({
    orderId: "abc-123",
    amount: 42,
  });
});

/**
 * Verifies routing: two `onDefer` handlers on the same function, each called
 * once. Each should fire exactly once, with the right data. Tests that the
 * synthetic function trigger filters on `_inngest.deferred_run.companion_id`
 * so each defer reaches only its own handler.
 */
test("multiple defer handlers are routed by companion_id", async () => {
  const state = createState({
    analyticsData: undefined as Record<string, unknown> | undefined,
    rollbackData: undefined as Record<string, unknown> | undefined,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      triggers: [{ event: eventName }],
      retries: 0,
      onDefer: {
        analytics: {
          handler: async ({ data }) => {
            state.analyticsData = data;
          },
        },
        rollback: {
          handler: async ({ data }) => {
            state.rollbackData = data;
          },
        },
      },
    },
    async ({ group, runId }) => {
      state.runId = runId;
      await group.defer.analytics("a", { kind: "analytics" });
      await group.defer.rollback("r", { kind: "rollback" });
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ data: {}, name: eventName });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.analyticsData).toBeDefined();
    expect(state.rollbackData).toBeDefined();
  });

  expect(state.analyticsData).toEqual({ kind: "analytics" });
  expect(state.rollbackData).toEqual({ kind: "rollback" });
});

/**
 * No-data defer: `group.defer.cleanup(stepId)` called without a data argument
 * should thread `{}` through to the handler via `event.data.input = {}`.
 */
test("defer with no data yields empty object in handler", async () => {
  const state = createState({
    reached: false,
    capturedData: undefined as Record<string, unknown> | undefined,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      triggers: [{ event: eventName }],
      retries: 0,
      onDefer: {
        cleanup: {
          handler: async ({ data }) => {
            state.reached = true;
            state.capturedData = data;
          },
        },
      },
    },
    async ({ group, runId }) => {
      state.runId = runId;
      await group.defer.cleanup("c");
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ data: {}, name: eventName });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.reached).toBe(true);
  });

  expect(state.capturedData).toEqual({});
});

/**
 * Deferred handler can use step tools durably. Verifies that the synthetic
 * function runs through the normal step execution path — step.run memoizes,
 * retries, etc. work inside a defer handler just like a main handler.
 */
test("deferred handler can use step.run for durable work", async () => {
  const state = createState({
    stepExecuted: false,
    stepOutputCaptured: undefined as string | undefined,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      triggers: [{ event: eventName }],
      retries: 0,
      onDefer: {
        work: {
          handler: async ({ data, step }) => {
            const greeting = await step.run("greet", () => {
              state.stepExecuted = true;
              return `hello ${data.name}`;
            });
            state.stepOutputCaptured = greeting as string;
          },
        },
      },
    },
    async ({ group, runId }) => {
      state.runId = runId;
      await group.defer.work("w", { name: "world" });
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ data: {}, name: eventName });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.stepExecuted).toBe(true);
    expect(state.stepOutputCaptured).toBe("hello world");
  });
});

/**
 * Cancel is currently broken end-to-end: the Go executor's
 * `handleGeneratorDeferCancel` looks up `defers[gen.ID]` where `gen.ID` is the
 * cancel step's hashed ID, but the defer was saved under the *defer* step's
 * hashed ID. Until the SDK and executor agree on how the cancel references
 * the original defer, this test is expected to fail — the deferred handler
 * still runs despite the cancel. Kept as `.todo` so the intent is tracked.
 */
test.todo("group.defer.cancel prevents the deferred handler from running");
