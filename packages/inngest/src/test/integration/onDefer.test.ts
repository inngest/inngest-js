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

test("onDefer handler is triggered by defer with schema", async () => {
  const state = createState({
    deferredData: null as { msg: string } | null,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        process: createDefer(client, {
          schema: z.object({ msg: z.string() }),
          handler: async ({ event, step }) => {
            expectTypeOf(event.data).not.toBeAny();
            expectTypeOf(event.data).toEqualTypeOf<{ msg: string }>();

            await step.run("capture-data", () => {
              state.deferredData = {
                msg: event.data.msg,
              };
            });
          },
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId, step }) => {
      state.runId = runId;

      const msg = await step.run("create-msg", () => {
        return "hello";
      });

      await defer.process("defer-1", { msg });
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.deferredData).toEqual({ msg: "hello" });
  });
});

test("no steps", async () => {
  const parentState = createState({ counter: 0 });
  const deferState = createState({ counter: 0 });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        process: createDefer(client, {
          handler: async () => {
            // TODO: Run ID

            deferState.counter++;
          },
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      parentState.counter++;
      await defer.process("defer-1", {});
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  expect(parentState.counter).toBe(1);

  await waitFor(() => {
    expect(deferState.counter).toBe(1);
  });
});

test("reentry", async () => {
  const parentState = createState({});
  const deferState = createState({ counter: 0 });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        process: createDefer(client, {
          handler: async () => {
            // TODO: Run ID

            deferState.counter++;
          },
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId, step }) => {
      parentState.runId = runId;
      await defer.process("defer-1", {});

      // Force reentry
      await step.sleep("sleep", "1s");
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();

  await waitFor(() => {
    expect(deferState.counter).toBe(1);
  });

  // Wait long enough to give the 2nd defer a chance to trigger (it shouldn't)
  await sleep(5000);

  expect(deferState.counter).toBe(1);
});

test("nested in step", async () => {
  const parentState = createState({});
  const deferState = createState({ counter: 0 });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        process: createDefer(client, {
          handler: async () => {
            // TODO: Run ID

            deferState.counter++;
          },
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId, step }) => {
      parentState.runId = runId;
      await step.run("a", async () => {
        await defer.process("defer-1", {});
      });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();

  await waitFor(() => {
    expect(deferState.counter).toBe(1);
  });
});

test("multiple onDefer handlers are independently triggered", async () => {
  const state = createState({
    emailData: null as { to: string } | null,
    paymentData: null as { amount: number } | null,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        sendEmail: createDefer(client, {
          schema: z.object({ to: z.string() }),
          handler: async ({ event, step }) => {
            expectTypeOf(event.data).not.toBeAny();
            expectTypeOf(event.data).toEqualTypeOf<{ to: string }>();

            await step.run("capture-email", () => {
              state.emailData = { to: event.data.to };
            });
          },
        }),
        processPayment: createDefer(client, {
          schema: z.object({ amount: z.number() }),
          handler: async ({ event, step }) => {
            expectTypeOf(event.data).not.toBeAny();
            expectTypeOf(event.data).toEqualTypeOf<{ amount: number }>();

            await step.run("capture-payment", () => {
              state.paymentData = { amount: event.data.amount };
            });
          },
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      state.runId = runId;

      await defer.sendEmail("send-email", { to: "a@b.com" });
      await defer.processPayment("process-payment", { amount: 100 });
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.emailData).toEqual({ to: "a@b.com" });
  });

  await waitFor(() => {
    expect(state.paymentData).toEqual({ amount: 100 });
  });
});

test("onDefer handler supports multiple steps", async () => {
  const state = createState({
    steps: [] as string[],
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        process: createDefer(client, {
          handler: async ({ step }) => {
            await step.run("step-a", () => {
              state.steps.push("a");
            });

            await step.sleep("pause", "1s");

            await step.run("step-b", () => {
              state.steps.push("b");
            });
          },
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      state.runId = runId;

      await defer.process("defer-it", {});
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.steps).toEqual(["a", "b"]);
  });
});

test("schema validation fails within main function", async () => {
  const state = createState({});

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        process: createDefer(client, {
          schema: z.object({ msg: z.string() }),
          handler: async () => {},
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      state.runId = runId;

      await defer.process("bad-defer", { msg: 123 } as never);
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  const error = await state.waitForRunFailed();
  expect(error).toBeDefined();
});

test("schema validation fails within onDefer handler", async () => {
  // Send a date so that it passes validation in the main function, but fails
  // when running the `onDefer` handler (since the date becomes an ISO string).

  const state = createState({ deferHandlerReached: false });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        process: createDefer(client, {
          schema: z.object({ date: z.date() }),
          handler: () => {
            state.deferHandlerReached = true;
          },
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      state.runId = runId;
      await defer.process("bad-defer", { date: new Date() });
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
        sendEmail: createDefer(client, {
          schema: z.object({ to: z.string() }),
          handler: async () => {},
        }),
        processPayment: createDefer(client, {
          schema: z.object({ amount: z.number() }),
          handler: async () => {},
        }),
      },
      triggers: { event: "test" },
    },
    async ({ defer }) => {
      expectTypeOf(defer.sendEmail).toBeFunction();
      expectTypeOf(defer.processPayment).toBeFunction();

      expectTypeOf(defer.sendEmail)
        .parameter(1)
        .toEqualTypeOf<{ to: string }>();
      expectTypeOf(defer.processPayment)
        .parameter(1)
        .toEqualTypeOf<{ amount: number }>();
    },
  );
});

test("no defer when onDefer is absent", () => {
  const client = new Inngest({ id: "type-test-2", isDev: true });

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
  const state = createState({
    deferredData: null as Record<string, unknown> | null,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        process: createDefer(client, {
          handler: async ({ event, step }) => {
            await step.run("capture-data", () => {
              state.deferredData = { key: event.data.key };
            });
          },
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      state.runId = runId;

      expectTypeOf(defer.process).toBeFunction();

      await defer.process("defer-it", { key: "value" });
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.deferredData).toEqual({ key: "value" });
  });
});

test("mixed onDefer entries: with and without schema", () => {
  const client = new Inngest({ id: "type-test-4", isDev: true });

  client.createFunction(
    {
      id: "mixed-defer",
      onDefer: {
        withSchema: createDefer(client, {
          schema: z.object({ msg: z.string() }),
          handler: async ({ event }) => {
            expectTypeOf(event.data).not.toBeAny();
            expectTypeOf(event.data.msg).toBeString();
          },
        }),
        withoutSchema: createDefer(client, {
          handler: async ({ event }) => {
            expectTypeOf(event.data).not.toBeAny();
            expectTypeOf(event.data).toEqualTypeOf<Record<string, any>>();
          },
        }),
      },
    },
    async ({ defer }) => {
      expectTypeOf(defer.withSchema).toBeFunction();
      expectTypeOf(defer.withSchema).toBeCallableWith("id", { msg: "hello" });
      expectTypeOf(defer.withoutSchema).toBeFunction();
      // no schema = any
      defer.withoutSchema("id", { anything: "goes" });
    },
  );
});

test("defer with id as first argument", async () => {
  const state = createState({
    deferredData: null as { msg: string } | null,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fn = client.createFunction(
    {
      id: "fn",
      onDefer: {
        process: createDefer(client, {
          schema: z.object({ msg: z.string() }),
          handler: async ({ event, step }) => {
            await step.run("capture-data", () => {
              state.deferredData = { msg: event.data.msg };
            });
          },
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      state.runId = runId;

      await defer.process("defer-msg", { msg: "from-defer" });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.deferredData).toEqual({ msg: "from-defer" });
  });
});

test("middleware", () => {
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
        foo: createDefer(client, {
          handler: async ({ db, event }) => {
            expectTypeOf(db).toEqualTypeOf<DB>();
          },
        }),
      },
    },
    async ({ db }) => {
      expectTypeOf(db).toEqualTypeOf<DB>();
    },
  );
});
