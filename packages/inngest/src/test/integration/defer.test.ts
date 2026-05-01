import {
  createState,
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createDefer } from "../../experimental.ts";
import {
  dependencyInjectionMiddleware,
  Inngest,
  Middleware,
} from "../../index.ts";
import { createServer } from "../../node.ts";
import { matrixCheckpointing } from "./utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("schema", async () => {
  // When a deferred function specifies a schema, both the static and runtime
  // types conform to the schema

  const parentState = createState({});
  const deferState = createState({
    eventData: null as { msg: string } | null,
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(
    client,
    { id: "process", schema: z.object({ msg: z.string() }) },
    async ({ event, runId }) => {
      deferState.runId = runId;
      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data).toEqualTypeOf<{ msg: string }>();
      deferState.eventData = event.data;
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
      const msg = await step.run("create-msg", () => {
        return "hello";
      });
      defer("foo", { function: foo, data: { msg } });
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
  expect(deferState.eventData).toEqual({ msg: "hello" });
});

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

test("schema validation fails in parent function", async () => {
  const state = createState({
    deferHandlerReached: false,
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(
    client,
    { id: "foo", schema: z.object({ msg: z.string() }) },
    async () => {
      state.deferHandlerReached = true;
    },
  );
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      state.runId = runId;
      defer("foo", { function: foo, data: { msg: 123 } as never });
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  const error = await state.waitForRunFailed();
  expect(error).toBeDefined();

  // Wait long enough to give the defer handler a chance to run (it shouldn't)
  await sleep(2000);
  expect(state.deferHandlerReached).toBe(false);
});

test("schema validation fails within defer handler", async () => {
  // Send a date so that it passes validation in the main function, but fails
  // when running the defer handler (since the date becomes an ISO string).

  const state = createState({ deferHandlerReached: false });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(
    client,
    { id: "foo", schema: z.object({ date: z.date() }) },
    () => {
      state.deferHandlerReached = true;
    },
  );
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      state.runId = runId;
      defer("foo", { function: foo, data: { date: new Date() } });
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  // Wait long enough to give the defer handler a chance to run (it shouldn't)
  await sleep(2000);
  expect(state.deferHandlerReached).toBe(false);
});

test("defer infers data type from passed function", () => {
  const client = new Inngest({ id: "type-test", isDev: true });

  const foo = createDefer(
    client,
    { id: "foo", schema: z.object({ to: z.string() }) },
    async () => {},
  );
  const bar = createDefer(
    client,
    { id: "bar", schema: z.object({ amount: z.number() }) },
    async () => {},
  );

  client.createFunction(
    {
      id: "typed-defer",
      triggers: { event: "test" },
    },
    async ({ defer }) => {
      expectTypeOf(defer).toBeFunction();
      defer("foo", { function: foo, data: { to: "a@b.com" } });
      defer("bar", { function: bar, data: { amount: 100 } });
    },
  );
});

test("defer is always present on context", () => {
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  client.createFunction(
    {
      id: "always-defer",
      triggers: { event: "test" },
    },
    async (ctx) => {
      expectTypeOf(ctx.defer).toBeFunction();
    },
  );
});

test("defer without schema defaults to any", async () => {
  const parentState = createState({
    deferredData: null as Record<string, unknown> | null,
  });
  const deferState = createState({
    eventData: null as Record<string, unknown> | null,
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(client, { id: "foo" }, async ({ event, runId }) => {
    deferState.runId = runId;
    deferState.eventData = event.data;
  });
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      defer("foo", { function: foo, data: { key: "value" } });
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
  expect(deferState.eventData).toEqual({ key: "value" });
});

test("mixed defer functions: with and without schema", () => {
  const client = new Inngest({ id: "type-test-4", isDev: true });

  const withSchema = createDefer(
    client,
    { id: "with-schema", schema: z.object({ msg: z.string() }) },
    async ({ event }) => {
      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data.msg).toBeString();
    },
  );
  const withoutSchema = createDefer(
    client,
    { id: "without-schema" },
    async ({ event }) => {
      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data).toEqualTypeOf<Record<string, any>>();
    },
  );

  client.createFunction(
    {
      id: "mixed-defer",
      triggers: { event: "test" },
    },
    async ({ defer }) => {
      defer("a", { function: withSchema, data: { msg: "hi" } });
      defer("b", { function: withoutSchema, data: { anything: true } });
    },
  );
});

describe("middleware", () => {
  test("dependency injection", () => {
    // Client-level dependency injection middleware is available in the defer
    // handler

    class DB {}
    const db = new DB();
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [dependencyInjectionMiddleware({ db })],
    });
    createDefer(client, { id: "foo" }, async ({ db }) => {
      expectTypeOf(db).toEqualTypeOf<DB>();
    });
    client.createFunction(
      {
        id: "mixed-defer",
        triggers: { event: "test" },
      },
      async ({ db }) => {
        expectTypeOf(db).toEqualTypeOf<DB>();
      },
    );
  });

  test("no step hooks", async () => {
    // Since `defer()` isn't a step we don't want to call any step-related hooks
    // for it

    const state = createState({
      hooks: {
        onRunStart: 0,
        onStepStart: 0,
        onStepComplete: 0,
        onStepError: 0,
        transformStepInput: 0,
        wrapStep: 0,
        wrapStepHandler: 0,
      },
    });

    class MW extends Middleware.BaseMiddleware {
      readonly id = "mw";
      override onRunStart() {
        state.hooks.onRunStart++;
      }
      override onStepStart() {
        state.hooks.onStepStart++;
      }
      override onStepComplete() {
        state.hooks.onStepComplete++;
      }
      override onStepError() {
        state.hooks.onStepError++;
      }
      override transformStepInput(arg: Middleware.TransformStepInputArgs) {
        state.hooks.transformStepInput++;
        return arg;
      }
      override wrapStep({ next }: Middleware.WrapStepArgs) {
        return next();
      }
      override wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
        return next();
      }
    }

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW],
    });
    const fooDefer = createDefer(client, { id: "foo" }, async () => {});
    const fn = client.createFunction(
      {
        id: "fn",
        triggers: { event: "test" },
      },
      async ({ defer, runId }) => {
        state.runId = runId;
        defer("foo", { function: fooDefer, data: {} });
      },
    );
    await createTestApp({
      client,
      functions: [fn, fooDefer],
      serve: createServer,
    });
    await client.send({ name: "test", data: {} });
    await state.waitForRunComplete();
    expect(state.hooks).toEqual({
      onRunStart: 1,
      onStepStart: 0,
      onStepComplete: 0,
      onStepError: 0,
      transformStepInput: 0,
      wrapStep: 0,
      wrapStepHandler: 0,
    });
  });
});

test("one defer shared across multiple parents", async () => {
  const state = createState({ counter: 0 });

  const eventA = randomSuffix("evtA");
  const eventB = randomSuffix("evtB");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  // Single defer function, referenced by two parents.
  const shared = createDefer(client, { id: "shared" }, async () => {
    state.counter++;
  });

  const fnA = client.createFunction(
    {
      id: "parent-a",
      retries: 0,
      triggers: { event: eventA },
    },
    async ({ defer }) => {
      defer("from-a", { function: shared, data: {} });
    },
  );
  const fnB = client.createFunction(
    {
      id: "parent-b",
      retries: 0,
      triggers: { event: eventB },
    },
    async ({ defer }) => {
      defer("from-b", { function: shared, data: {} });
    },
  );
  await createTestApp({
    client,
    functions: [fnA, fnB, shared],
    serve: createServer,
  });

  await client.send({ name: eventA, data: {} });
  await client.send({ name: eventB, data: {} });

  await waitFor(() => {
    expect(state.counter).toBe(2);
  });
});
