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
import { dependencyInjectionMiddleware, Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

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
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        foo: createDefer(
          client,
          { id: "process", schema: z.object({ msg: z.string() }) },
          async ({ event, runId }) => {
            deferState.runId = runId;
            expectTypeOf(event.data).not.toBeAny();
            expectTypeOf(event.data).toEqualTypeOf<{ msg: string }>();
            deferState.eventData = event.data;
          },
        ),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId, step }) => {
      parentState.runId = runId;
      const msg = await step.run("create-msg", () => {
        return "hello";
      });
      defer.foo("foo", { msg });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

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
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        foo: createDefer(client, { id: "foo" }, async ({ runId }) => {
          deferState.runId = runId;
          deferState.counter++;
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId, step }) => {
      parentState.runId = runId;
      defer.foo("foo", {});

      // Force reentry so that the previous `defer` method runs again
      await step.sleep("sleep", "1s");
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

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
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        foo: createDefer(client, { id: "foo" }, async ({ runId }) => {
          deferState.runId = runId;
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId, step }) => {
      parentState.runId = runId;
      await step.run("a", async () => {
        defer.foo("foo", {});
      });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();
});

test("multiple onDefer handlers are independently triggered", async () => {
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
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        foo: createDefer(
          client,
          { id: "foo", schema: z.object({ to: z.string() }) },
          async ({ event, runId }) => {
            deferFooState.runId = runId;
            expectTypeOf(event.data).not.toBeAny();
            expectTypeOf(event.data).toEqualTypeOf<{ to: string }>();
            deferFooState.eventData = event.data;
          },
        ),
        bar: createDefer(
          client,
          { id: "bar", schema: z.object({ amount: z.number() }) },
          async ({ event, runId }) => {
            deferBarState.runId = runId;
            expectTypeOf(event.data).not.toBeAny();
            expectTypeOf(event.data).toEqualTypeOf<{ amount: number }>();
            deferBarState.eventData = event.data;
          },
        ),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      defer.foo("foo", { to: "a@b.com" });
      defer.bar("bar", { amount: 100 });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

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
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        foo: createDefer(client, { id: "foo" }, async ({ runId, step }) => {
          deferState.runId = runId;

          await step.run("step-a", () => {
            deferState.steps.push("a");
          });

          // Force reentry
          await step.sleep("pause", "1s");

          await step.run("step-b", () => {
            deferState.steps.push("b");
          });
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      defer.foo("foo", {});
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

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
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        foo: createDefer(
          client,
          { id: "foo", schema: z.object({ msg: z.string() }) },
          async () => {
            state.deferHandlerReached = true;
          },
        ),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      state.runId = runId;
      defer.foo("foo", { msg: 123 } as never);
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  const error = await state.waitForRunFailed();
  expect(error).toBeDefined();

  // Wait long enough to give the `onDefer` handler a chance to run (it
  // shouldn't)
  await sleep(2000);
  expect(state.deferHandlerReached).toBe(false);
});

test("schema validation fails within onDefer handler", async () => {
  // Send a date so that it passes validation in the main function, but fails
  // when running the `onDefer` handler (since the date becomes an ISO string).

  const state = createState({ deferHandlerReached: false });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        foo: createDefer(
          client,
          { id: "foo", schema: z.object({ date: z.date() }) },
          () => {
            state.deferHandlerReached = true;
          },
        ),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      state.runId = runId;
      defer.foo("foo", { date: new Date() });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  // Wait long enough to give the `onDefer` handler a chance to run (it
  // shouldn't)
  await sleep(2000);
  expect(state.deferHandlerReached).toBe(false);
});

test("defer mirrors onDefer keys with typed methods", () => {
  const client = new Inngest({ id: "type-test", isDev: true });

  client.createFunction(
    {
      id: "typed-defer",
      onDefer: {
        foo: createDefer(
          client,
          { id: "foo", schema: z.object({ to: z.string() }) },
          async () => {},
        ),
        bar: createDefer(
          client,
          { id: "bar", schema: z.object({ amount: z.number() }) },
          async () => {},
        ),
      },
      triggers: { event: "test" },
    },
    async ({ defer }) => {
      expectTypeOf(defer.foo).toBeFunction();
      expectTypeOf(defer.bar).toBeFunction();

      expectTypeOf(defer.foo).parameter(1).toEqualTypeOf<{ to: string }>();
      expectTypeOf(defer.bar).parameter(1).toEqualTypeOf<{ amount: number }>();
    },
  );
});

test("no `defer` property when onDefer is absent", () => {
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  client.createFunction(
    {
      id: "no-defer",
      triggers: { event: "test" },
    },
    async (ctx) => {
      expectTypeOf(ctx).not.toHaveProperty("defer");
    },
  );
});

test("onDefer without schema defaults to any", async () => {
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
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        foo: createDefer(
          client,
          { id: "foo" },
          async ({ event, runId, step }) => {
            deferState.runId = runId;
            deferState.eventData = event.data;
          },
        ),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      expectTypeOf(defer.foo).toBeFunction();
      defer.foo("foo", { key: "value" });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();
  expect(deferState.eventData).toEqual({ key: "value" });
});

test("mixed onDefer entries: with and without schema", () => {
  const client = new Inngest({ id: "type-test-4", isDev: true });

  client.createFunction(
    {
      id: "mixed-defer",
      onDefer: {
        withSchema: createDefer(
          client,
          { id: "with-schema", schema: z.object({ msg: z.string() }) },
          async ({ event }) => {
            expectTypeOf(event.data).not.toBeAny();
            expectTypeOf(event.data.msg).toBeString();
          },
        ),
        withoutSchema: createDefer(
          client,
          { id: "without-schema" },
          async ({ event }) => {
            expectTypeOf(event.data).not.toBeAny();
            expectTypeOf(event.data).toEqualTypeOf<Record<string, any>>();
          },
        ),
      },
    },
    async ({ defer }) => {
      expectTypeOf(defer.withSchema).toBeFunction();
      expectTypeOf(defer.withSchema)
        .parameter(1)
        .toEqualTypeOf<{ msg: string }>();

      expectTypeOf(defer.withoutSchema).toBeFunction();
      expectTypeOf(defer.withoutSchema).parameter(1).toEqualTypeOf<any>();
    },
  );
});

test("dependency injection", () => {
  // Client-level dependency injection middleware is available in the onDefer
  // handler

  class DB {}
  const db = new DB();
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [dependencyInjectionMiddleware({ db })],
  });
  client.createFunction(
    {
      id: "mixed-defer",
      onDefer: {
        foo: createDefer(client, { id: "foo" }, async ({ db, event }) => {
          expectTypeOf(db).toEqualTypeOf<DB>();
        }),
      },
    },
    async ({ db }) => {
      expectTypeOf(db).toEqualTypeOf<DB>();
    },
  );
});

test("one defer shared across multiple parents", async () => {
  const state = createState({ counter: 0 });

  const eventA = randomSuffix("evtA");
  const eventB = randomSuffix("evtB");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  // Single defer function, referenced by two parents under different aliases.
  const shared = createDefer(client, { id: "shared" }, async () => {
    state.counter++;
  });

  const fnA = client.createFunction(
    {
      id: "parent-a",
      retries: 0,
      triggers: { event: eventA },
      onDefer: { task: shared },
    },
    async ({ defer }) => {
      defer.task("from-a", {});
    },
  );
  const fnB = client.createFunction(
    {
      id: "parent-b",
      retries: 0,
      triggers: { event: eventB },
      onDefer: { otherName: shared },
    },
    async ({ defer }) => {
      defer.otherName("from-b", {});
    },
  );
  await createTestApp({
    client,
    functions: [fnA, fnB],
    serve: createServer,
  });

  await client.send({ name: eventA, data: {} });
  await client.send({ name: eventB, data: {} });

  await waitFor(() => {
    expect(state.counter).toBe(2);
  });
});
