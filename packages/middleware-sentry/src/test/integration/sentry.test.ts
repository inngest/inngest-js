import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { Inngest } from "inngest";
import { describe, expect, test } from "vitest";
import { SentryMiddleware, sentryMiddleware } from "../../middleware.ts";
import {
  capturedErrors,
  capturedStepErrors,
  capturedTransactions,
  collectSpanNames,
  errorHasException,
  initSentryCapture,
} from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("function with steps succeeds", async () => {
  const captured = initSentryCapture();

  const state = createState({});

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [SentryMiddleware],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      const a = await step.run("step-a", () => 1);
      const b = await step.run("step-b", () => 2);
      return a + b;
    },
  );

  await createTestApp({ client, functions: [fn] });
  await client.send({ name: eventName });
  const fnOutput = await state.waitForRunComplete();
  expect(fnOutput).toBe(3);

  await waitFor(() => {
    expect(capturedTransactions(captured).length).toBeGreaterThanOrEqual(1);
  });

  // No error events for a successful run
  expect(capturedErrors(captured)).toHaveLength(0);
});

test("ctx.sentry is injected via transformFunctionInput", async () => {
  initSentryCapture();

  const state = createState({
    sentry: undefined as unknown,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [SentryMiddleware],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ sentry, runId }) => {
      state.runId = runId;
      state.sentry = sentry;
    },
  );

  await createTestApp({ client, functions: [fn] });
  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.sentry).toHaveProperty("captureException");
  expect(state.sentry).toHaveProperty("startSpan");
});

test("error events captured on function error", async () => {
  const captured = initSentryCapture();

  const state = createState({});

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [SentryMiddleware],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId }) => {
      state.runId = runId;
      throw new Error("boom");
    },
  );

  await createTestApp({ client, functions: [fn] });
  await client.send({ name: eventName });
  await state.waitForRunFailed();

  await waitFor(() => {
    const errors = capturedErrors(captured);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => errorHasException(e, "boom"))).toBe(true);
  });
});

describe("captureStepErrors", () => {
  test("not captured by default", async () => {
    const captured = initSentryCapture();

    const state = createState({});

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [SentryMiddleware],
    });

    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        state.runId = runId;
        try {
          await step.run("failing-step", () => {
            throw new Error("step fail");
          });
        } catch {
          // swallow
        }
      },
    );

    await createTestApp({ client, functions: [fn] });
    await client.send({ name: eventName });
    await state.waitForRunComplete();

    // Wait a bit to ensure nothing arrives
    await new Promise((r) => setTimeout(r, 2000));

    expect(capturedStepErrors(captured)).toHaveLength(0);
  });

  test("captured when enabled", async () => {
    const captured = initSentryCapture();

    const state = createState({});

    const Cls = sentryMiddleware({ captureStepErrors: true });

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [Cls],
    });

    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        state.runId = runId;
        try {
          await step.run("failing-step", () => {
            throw new Error("step fail");
          });
        } catch {
          // swallow
        }
      },
    );

    await createTestApp({ client, functions: [fn] });
    await client.send({ name: eventName });
    await state.waitForRunComplete();

    await waitFor(() => {
      expect(capturedStepErrors(captured).length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("onlyCaptureFinalAttempt", () => {
  test("only final attempt captured by default", async () => {
    const captured = initSentryCapture();

    const state = createState({
      attempts: 0,
    });

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [SentryMiddleware],
    });

    const fn = client.createFunction(
      { id: "fn", retries: 1, triggers: [{ event: eventName }] },
      async ({ runId }) => {
        state.runId = runId;
        state.attempts++;
        throw new Error("transient");
      },
    );

    await createTestApp({ client, functions: [fn] });
    await client.send({ name: eventName });

    await waitFor(() => {
      expect(state.attempts).toBe(2);
    });

    await state.waitForRunFailed();

    await waitFor(() => {
      expect(capturedErrors(captured).length).toBeGreaterThanOrEqual(1);
    });

    const transientErrors = capturedErrors(captured).filter((e) =>
      errorHasException(e, "transient"),
    );
    expect(transientErrors).toHaveLength(1);
  });

  test("all attempts captured when disabled", async () => {
    const captured = initSentryCapture();

    const state = createState({
      attempts: 0,
    });

    const Cls = sentryMiddleware({ onlyCaptureFinalAttempt: false });

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [Cls],
    });

    const fn = client.createFunction(
      { id: "fn", retries: 1, triggers: [{ event: eventName }] },
      async ({ runId }) => {
        state.runId = runId;
        state.attempts++;
        throw new Error("all-attempts");
      },
    );

    await createTestApp({ client, functions: [fn] });
    await client.send({ name: eventName });

    await waitFor(() => {
      expect(state.attempts).toBe(2);
    });

    await state.waitForRunFailed();

    await waitFor(() => {
      const matching = capturedErrors(captured).filter((e) =>
        errorHasException(e, "all-attempts"),
      );
      expect(matching.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("disableAutomaticFlush", () => {
  test("errors are captured with flush enabled (default)", async () => {
    const captured = initSentryCapture();

    const state = createState({});

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [SentryMiddleware],
    });

    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ runId }) => {
        state.runId = runId;
        throw new Error("flushed-error");
      },
    );

    await createTestApp({ client, functions: [fn] });
    await client.send({ name: eventName });
    await state.waitForRunFailed();

    await waitFor(() => {
      const matching = capturedErrors(captured).filter((e) =>
        errorHasException(e, "flushed-error"),
      );
      expect(matching.length).toBeGreaterThanOrEqual(1);
    });
  });

  test("works without crashing when disabled", async () => {
    initSentryCapture();

    const state = createState({
      result: null as unknown,
    });

    const Cls = sentryMiddleware({ disableAutomaticFlush: true });

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [Cls],
    });

    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        state.runId = runId;
        state.result = await step.run("compute", () => 42);
        return state.result;
      },
    );

    await createTestApp({ client, functions: [fn] });
    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.result).toBe(42);
  });
});

test("step spans created with correct names", async () => {
  const captured = initSentryCapture();

  const state = createState({});

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [SentryMiddleware],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      await step.run("fetch-user", () => "alice");
      await step.run("send-email", () => "sent");
    },
  );

  await createTestApp({ client, functions: [fn] });
  await client.send({ name: eventName });
  await state.waitForRunComplete();

  await waitFor(() => {
    const spanNames = collectSpanNames(captured);
    expect(spanNames).toContain("fetch-user");
    expect(spanNames).toContain("send-email");
  });
});

test("display name preferred over step ID", async () => {
  const captured = initSentryCapture();

  const state = createState({});

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [SentryMiddleware],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      await step.run({ id: "fetch-user", name: "Fetch User" }, () => "alice");
    },
  );

  await createTestApp({ client, functions: [fn] });
  await client.send({ name: eventName });
  await state.waitForRunComplete();
  await waitFor(() => {
    expect(capturedTransactions(captured).length).toBeGreaterThanOrEqual(1);
  });

  const spanNames = collectSpanNames(captured);
  expect(spanNames).toContain("Fetch User");
  expect(spanNames).not.toContain("fetch-user");
});

test("request span uses function name", async () => {
  const captured = initSentryCapture();

  const state = createState({});

  const eventName = randomSuffix("evt");
  const fnName = randomSuffix("My Func");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [SentryMiddleware],
  });

  const fn = client.createFunction(
    {
      id: "fn",
      name: fnName,
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ runId }) => {
      state.runId = runId;
    },
  );

  await createTestApp({ client, functions: [fn] });
  await client.send({ name: eventName });
  await state.waitForRunComplete();

  await waitFor(() => {
    const transactions = capturedTransactions(captured);
    const hasMatchingTransaction = transactions.some((tx) => {
      return tx.payload.transaction === fnName;
    });
    expect(hasMatchingTransaction).toBe(true);
  });
});
