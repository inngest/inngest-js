import {
  createState,
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createDefer } from "../../../experimental.ts";
import { Inngest, NonRetriableError, RetryAfterError } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import { matrixCheckpointing, spyLogger } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("re-encountered defer does not trigger new deferred run", async () => {
  // When a deferred function is re-encountered (e.g. function re-entry), it
  // should not trigger a new deferred run

  const parentState = createState({});
  const deferState = createState({ counter: 0 });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
    deferState.runId = runId;
    deferState.counter++;
  });
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId, step }) => {
      parentState.runId = runId;
      defer("foo", { function: foo, data: {} });

      // Force reentry so that the previous `defer` method runs again
      await step.sleep("sleep", "1s");
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();

  // Wait long enough to give the 2nd defer a chance to trigger (it shouldn't)
  await sleep(5000);

  expect(deferState.counter).toBe(1);
});

describe("defer ID collision", async () => {
  const cases = [
    { name: "same checkpoint request", checkpointing: true, sameRequest: true },
    {
      name: "different checkpoint request",
      checkpointing: true,
      sameRequest: false,
    },
    {
      name: "different non-checkpointing request",
      checkpointing: false,
      sameRequest: false,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      // Defer IDs must be unique within a run. If a duplicate is detected, the SDK
      // logs a warning and doesn't report the duplicate.

      const parentState = createState({});
      const deferState = createState({
        count: 0,
        index: null as number | null,
      });

      const internalLogger = spyLogger();
      const client = new Inngest({
        checkpointing: c.checkpointing,
        id: randomSuffix(testFileName),
        isDev: true,
        internalLogger,
      });
      const eventName = randomSuffix("evt");
      const foo = createDefer(
        client,
        { id: "foo" },
        async ({ event, runId }) => {
          deferState.runId = runId;
          deferState.index = event.data.index;
          deferState.count++;
        },
      );
      const fn = client.createFunction(
        {
          id: "fn",
          retries: 0,
          triggers: { event: eventName },
        },
        async ({ defer, runId, step }) => {
          parentState.runId = runId;
          defer("dupe", { function: foo, data: { index: 0 } });

          if (!c.sameRequest) {
            // Add a step to ensure that the two defer calls won't be in the
            // same outgoing checkpoint request
            await step.run("between", async () => {});
          }

          // Doesn't report
          defer("dupe", { function: foo, data: { index: 1 } });
        },
      );
      await createTestApp({
        client,
        functions: [fn, foo],
        serve: createServer,
      });

      await client.send({ name: eventName, data: {} });
      await parentState.waitForRunComplete();
      await deferState.waitForRunComplete();
      expect(deferState.index).toBe(0);
      expect(internalLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "dupe",
          runId: parentState.runId,
        }),
        "defer skipped: duplicate ID within run",
      );

      // Wait long enough to give the 2nd defer a chance to trigger (it
      // shouldn't)
      await sleep(5000);
      expect(deferState.count).toBe(1);
    });
  }
});

test("defer in step", async () => {
  // Can call `defer` within a step

  const parentState = createState({});
  const deferState = createState({});

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
    deferState.runId = runId;
  });
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId, step }) => {
      parentState.runId = runId;
      await step.run("a", async () => {
        defer("foo", { function: foo, data: {} });
      });
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();
});

matrixCheckpointing("defer at end of function", async (checkpointing) => {
  // Ensure that we respond with `[DeferAdd, RunComplete]` opcodes when
  // encountering a defer at the end of the function. This is necessary because
  // the Executor errors when it only receives a `[DeferAdd]` opcode response.
  //
  // While this test might seem like overkill, we added it because we
  // encountered a regression.

  const parentState = createState({ requestCount: 0 });
  const deferState = createState({});

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    checkpointing,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
    deferState.runId = runId;
  });
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      parentState.requestCount++;
      defer("foo", { function: foo, data: {} });
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();
  expect(parentState.requestCount).toBe(1);
});

matrixCheckpointing(
  "defer at end of failed function",
  async (checkpointing) => {
    // Ensure that we respond with `[DeferAdd, StepFailed]` opcodes when the
    // function throws immediately after a defer with no retries remaining. The
    // defer must still fire even though the run fails.

    const parentState = createState({});
    const deferState = createState({});

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      checkpointing,
    });
    const eventName = randomSuffix("evt");
    const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
      deferState.runId = runId;
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ defer, runId }) => {
        parentState.runId = runId;
        defer("foo", { function: foo, data: {} });
        throw new Error("oh no");
      },
    );
    await createTestApp({
      client,
      functions: [fn, foo],
      serve: createServer,
    });

    await client.send({ name: eventName, data: {} });
    const error = await parentState.waitForRunFailed();
    expect(error).toMatchObject({ message: "oh no" });
    await deferState.waitForRunComplete();
  },
);

matrixCheckpointing(
  "defer at end of errored function",
  async (checkpointing) => {
    // Ensure that we respond with `[DeferAdd, StepError]` opcodes when the
    // function throws immediately after a defer but still has retries
    // remaining. The run must complete on retry and the defer must fire
    // exactly once, since the retry re-encounters the memoized defer.

    const parentState = createState({ requestCount: 0 });
    const deferState = createState({ counter: 0 });

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      checkpointing,
    });
    const eventName = randomSuffix("evt");
    const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
      deferState.runId = runId;
      deferState.counter++;
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 1,
        triggers: { event: eventName },
      },
      async ({ attempt, defer, runId }) => {
        parentState.runId = runId;
        parentState.requestCount++;
        defer("foo", { function: foo, data: {} });

        if (attempt === 0) {
          throw new Error("oh no");
        }
      },
    );
    await createTestApp({
      client,
      functions: [fn, foo],
      serve: createServer,
    });

    await client.send({ name: eventName, data: {} });
    await parentState.waitForRunComplete();
    await deferState.waitForRunComplete();
    expect(parentState.requestCount).toBe(2);

    // Wait long enough to give a 2nd defer a chance to trigger (it shouldn't)
    await sleep(5000);
    expect(deferState.counter).toBe(1);
  },
);

matrixCheckpointing(
  "NonRetriableError after defer fails without retrying",
  async (checkpointing) => {
    // A NonRetriableError thrown at the function level after a defer must
    // fail the run, and the defer must still fire exactly once.

    const parentState = createState({});
    const deferState = createState({ counter: 0 });

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      checkpointing,
    });
    const eventName = randomSuffix("evt");
    const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
      deferState.runId = runId;
      deferState.counter++;
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 1,
        triggers: { event: eventName },
      },
      async ({ defer, runId }) => {
        parentState.runId = runId;
        defer("foo", { function: foo, data: {} });
        throw new NonRetriableError("permanent failure");
      },
    );
    await createTestApp({
      client,
      functions: [fn, foo],
      serve: createServer,
    });

    await client.send({ name: eventName, data: {} });
    const error = await parentState.waitForRunFailed();
    expect(error).toMatchObject({ message: "permanent failure" });
    await deferState.waitForRunComplete();

    // Wait long enough for a second defer to have fired (it shouldn't)
    await sleep(5000);
    expect(deferState.counter).toBe(1);
  },
);

matrixCheckpointing(
  "error-discovery replay does not re-run the handler",
  async (checkpointing) => {
    // A rejection shipped alongside a buffered defer rides a
    // `[DeferAdd, StepFailed]` batch, which the executor memoizes and replays
    // for error discovery. The SDK must detect the memoized rejection and
    // short-circuit instead of re-running user code, so the handler executes
    // exactly once.

    const parentState = createState({ requestCount: 0 });
    const deferState = createState({});

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      checkpointing,
    });
    const eventName = randomSuffix("evt");
    const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
      deferState.runId = runId;
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ defer, runId }) => {
        parentState.runId = runId;
        parentState.requestCount++;
        defer("foo", { function: foo, data: {} });
        throw new Error("oh no");
      },
    );
    await createTestApp({
      client,
      functions: [fn, foo],
      serve: createServer,
    });

    await client.send({ name: eventName, data: {} });
    const error = await parentState.waitForRunFailed();
    expect(error).toMatchObject({ message: "oh no" });
    await deferState.waitForRunComplete();

    // Wait long enough for the error-discovery replay to have re-run the
    // handler (it shouldn't)
    await sleep(5000);
    expect(parentState.requestCount).toBe(1);
  },
);

matrixCheckpointing(
  "RetryAfterError after defer delays the retry",
  async (checkpointing) => {
    // A RetryAfterError thrown at the function level after a defer must delay
    // the retry by the given duration, and the defer must fire exactly once
    // across attempts.

    const parentState = createState({ attemptTimes: [] as number[] });
    const deferState = createState({ counter: 0 });

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      checkpointing,
    });
    const eventName = randomSuffix("evt");
    const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
      deferState.runId = runId;
      deferState.counter++;
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 1,
        triggers: { event: eventName },
      },
      async ({ attempt, defer, runId }) => {
        parentState.runId = runId;
        parentState.attemptTimes.push(Date.now());
        defer("foo", { function: foo, data: {} });

        if (attempt === 0) {
          throw new RetryAfterError("rate limited", "5s");
        }
      },
    );
    await createTestApp({
      client,
      functions: [fn, foo],
      serve: createServer,
    });

    await client.send({ name: eventName, data: {} });
    await parentState.waitForRunComplete();
    await deferState.waitForRunComplete();

    expect(parentState.attemptTimes).toHaveLength(2);

    // The dev server runs with `--retry-interval 1`, so a retry that ignored
    // the Retry-After would land ~1s after the failure
    const retryDelay =
      parentState.attemptTimes[1]! - parentState.attemptTimes[0]!;
    expect(retryDelay).toBeGreaterThanOrEqual(4000);

    // Wait long enough to give a 2nd defer a chance to trigger (it shouldn't)
    await sleep(5000);
    expect(deferState.counter).toBe(1);
  },
);

test("multiple defer functions are independently triggered", async () => {
  const parentState = createState({
    emailData: null as { to: string } | null,
    paymentData: null as { amount: number } | null,
  });
  const deferFooState = createState({
    eventData: null as { to: string } | null,
  });
  const deferBarState = createState({
    eventData: null as { amount: number } | null,
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(
    client,
    { id: "foo", schema: z.object({ to: z.string() }) },
    async ({ event, runId }) => {
      deferFooState.runId = runId;
      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data).toEqualTypeOf<{ to: string }>();
      deferFooState.eventData = event.data;
    },
  );
  const bar = createDefer(
    client,
    { id: "bar", schema: z.object({ amount: z.number() }) },
    async ({ event, runId }) => {
      deferBarState.runId = runId;
      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data).toEqualTypeOf<{ amount: number }>();
      deferBarState.eventData = event.data;
    },
  );
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      defer("foo", { function: foo, data: { to: "a@b.com" } });
      defer("bar", { function: bar, data: { amount: 100 } });
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo, bar],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();

  await deferFooState.waitForRunComplete();
  expect(deferFooState.eventData).toEqual({ to: "a@b.com" });

  await deferBarState.waitForRunComplete();
  expect(deferBarState.eventData).toEqual({ amount: 100 });
});

test("multiple steps in defer handler", async () => {
  const parentState = createState({});
  const deferState = createState({
    steps: [] as string[],
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(client, { id: "foo" }, async ({ runId, step }) => {
    deferState.runId = runId;

    await step.run("step-a", () => {
      deferState.steps.push("a");
    });

    // Force reentry
    await step.sleep("pause", "1s");

    await step.run("step-b", () => {
      deferState.steps.push("b");
    });
  });
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      defer("foo", { function: foo, data: {} });
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();
  expect(deferState.steps).toEqual(["a", "b"]);
});

test("can't pass a normal function", async () => {
  // Passing a normal function to `defer` doesn't work. It also doesn't fail the
  // run.

  const parentState = createState({});
  const childState = createState({});

  const internalLogger = spyLogger();
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    internalLogger,
  });
  const fn1 = client.createFunction(
    {
      id: "fn-1",
      retries: 0,
    },
    async ({ runId }) => {
      childState.runId = runId;
    },
  );
  const eventName = randomSuffix("evt");
  const fn2 = client.createFunction(
    {
      id: "fn-2",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      defer("defer", {
        // @ts-expect-error: should fail
        function: defer,

        data: {},
      });
    },
  );
  await createTestApp({
    client,
    functions: [fn1, fn2],
    serve: createServer,
  });
  await client.send({ name: eventName });
  await parentState.waitForRunComplete();

  // Wait long enough to give the child function a chance to run (it shouldn't)
  await sleep(5000);
  expect(childState.runId).toBeNull();

  expect(internalLogger.error).toHaveBeenCalledWith(
    expect.objectContaining({ runId: parentState.runId }),
    "defer skipped: function not created via createDefer",
  );
});

test("propagates experiment ref to the deferred run", async () => {
  const childState = createState({
    parents: null as unknown as {
      fnSlug: string;
      runId: string;
      experiment?: { experimentName: string; variant: string };
    }[],
  });
  const client = new Inngest({ id: randomSuffix(testFileName), isDev: true });
  const eventName = randomSuffix("evt");

  const child = createDefer(
    client,
    { id: "child" },
    async ({ parents, runId }) => {
      childState.runId = runId;
      childState.parents = parents;
    },
  );
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: { event: eventName } },
    async ({ defer }) => {
      defer("c", {
        function: child,
        data: {},
        experiment: { experimentName: "checkout-flow", variant: "control" },
      });
    },
  );
  await createTestApp({ client, functions: [fn, child], serve: createServer });
  await client.send({ name: eventName, data: {} });
  await childState.waitForRunComplete();

  expect(childState.parents[0]!.experiment).toEqual({
    experimentName: "checkout-flow",
    variant: "control",
  });
});
