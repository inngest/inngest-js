import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { dependencyInjectionMiddleware, Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("onDefer handler is triggered by step.defer with schema", async () => {
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
        process: client.createDefer({
          schema: z.object({ msg: z.string() }),
          handler: async ({ event, step }) => {
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
    async ({ runId, step }) => {
      state.runId = runId;

      const msg = await step.run("create-msg", () => {
        return "hello";
      });

      await step.defer.process("defer-1", { msg });
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.deferredData).toEqual({ msg: "hello" });
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
        sendEmail: client.createDefer({
          schema: z.object({ to: z.string() }),
          handler: async ({ event, step }) => {
            await step.run("capture-email", () => {
              state.emailData = { to: event.data.to };
            });
          },
        }),
        processPayment: client.createDefer({
          schema: z.object({ amount: z.number() }),
          handler: async ({ event, step }) => {
            await step.run("capture-payment", () => {
              state.paymentData = { amount: event.data.amount };
            });
          },
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ runId, step }) => {
      state.runId = runId;

      await step.defer.sendEmail("send-email", { to: "a@b.com" });
      await step.defer.processPayment("process-payment", { amount: 100 });
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
        process: client.createDefer({
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
    async ({ runId, step }) => {
      state.runId = runId;

      await step.defer.process("defer-it", {});
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.steps).toEqual(["a", "b"]);
  });
});

test("schema validation fails", async () => {
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
        process: client.createDefer({
          schema: z.object({ msg: z.string() }),
          handler: async () => {},
        }),
      },
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ runId, step }) => {
      state.runId = runId;

      await step.defer.process("bad-defer", { msg: 123 } as never);
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  const error = await state.waitForRunFailed();
  expect(error).toBeDefined();
});

test("step.defer mirrors onDefer keys with typed methods", () => {
  const client = new Inngest({ id: "type-test", isDev: true });

  client.createFunction(
    {
      id: "typed-defer",
      onDefer: {
        sendEmail: client.createDefer({
          schema: z.object({ to: z.string() }),
          handler: async () => {},
        }),
        processPayment: client.createDefer({
          schema: z.object({ amount: z.number() }),
          handler: async () => {},
        }),
      },
      triggers: { event: "test" },
    },
    async ({ defer, step }) => {
      expectTypeOf(defer.sendEmail).toBeFunction();
      expectTypeOf(defer.processPayment).toBeFunction();

      expectTypeOf(defer.sendEmail)
        .parameter(0)
        .toEqualTypeOf<{ to: string }>();
      expectTypeOf(defer.processPayment)
        .parameter(0)
        .toEqualTypeOf<{ amount: number }>();

      expectTypeOf(step.defer.sendEmail).toBeFunction();
      expectTypeOf(step.defer.processPayment).toBeFunction();

      expectTypeOf(step.defer.sendEmail)
        .parameter(1)
        .toEqualTypeOf<{ to: string }>();
      expectTypeOf(step.defer.processPayment)
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
      expectTypeOf(ctx.step).not.toHaveProperty("defer");
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
        process: client.createDefer({
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
    async ({ runId, step }) => {
      state.runId = runId;

      expectTypeOf(step.defer.process).toBeFunction();

      await step.defer.process("defer-it", { key: "value" });
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
        withSchema: client.createDefer({
          schema: z.object({ msg: z.string() }),
          handler: async ({ event }) => {
            expectTypeOf(event.data.msg).toBeString();
          },
        }),
        withoutSchema: client.createDefer({
          handler: async ({ event }) => {
            expectTypeOf(event.data.anything).toBeAny();
          },
        }),
      },
    },
    async ({ defer, step }) => {
      expectTypeOf(defer.withSchema).toBeFunction();
      expectTypeOf(defer.withSchema).toBeCallableWith({ msg: "hello" });
      expectTypeOf(defer.withoutSchema).toBeFunction();
      // no schema = any
      defer.withoutSchema({ anything: "goes" });

      expectTypeOf(step.defer.withSchema).toBeFunction();
      expectTypeOf(step.defer.withoutSchema).toBeFunction();
    },
  );
});

test("plain defer function", async () => {
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
        process: client.createDefer({
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
    async ({ defer, runId, step }) => {
      state.runId = runId;

      await defer.process({ msg: "from-plain-defer" });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  await waitFor(() => {
    expect(state.deferredData).toEqual({ msg: "from-plain-defer" });
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
        foo: client.createDefer({
          handler: async ({ db }) => {
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
