import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("onDefer handler is triggered by defer() with schema", async () => {
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
        process: {
          schema: z.object({ msg: z.string() }),
          handler: async ({ event, step }) => {
            await step.run("capture-data", () => {
              state.deferredData = {
                msg: event.data.msg,
              };
            });
          },
        },
      },
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ defer, runId, step }) => {
      state.runId = runId;

      const msg = await step.run("create-msg", () => {
        return "hello";
      });

      await step.run("defer-1", async () => {
        await defer.process({ msg });
      });
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
        sendEmail: {
          schema: z.object({ to: z.string() }),
          handler: async ({ event, step }) => {
            await step.run("capture-email", () => {
              state.emailData = { to: event.data.to };
            });
          },
        },
        processPayment: {
          schema: z.object({ amount: z.number() }),
          handler: async ({ event, step }) => {
            await step.run("capture-payment", () => {
              state.paymentData = { amount: event.data.amount };
            });
          },
        },
      },
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ defer, runId, step }) => {
      state.runId = runId;

      await step.run("send-email", async () => {
        await defer.sendEmail({ to: "a@b.com" });
      });

      await step.run("process-payment", async () => {
        await defer.processPayment({ amount: 100 });
      });
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
        process: {
          schema: z.object({ msg: z.string() }),
          handler: async () => {},
        },
      },
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ defer, runId, step }) => {
      state.runId = runId;

      await step.run("bad-defer", async () => {
        // @ts-expect-error intentionally passing wrong type
        await defer.process({ msg: 123 });
      });
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  const error = await state.waitForRunFailed();
  expect(error).toBeDefined();
});

test("defer mirrors onDefer keys with typed methods", () => {
  const client = new Inngest({ id: "type-test", isDev: true });

  client.createFunction(
    {
      id: "typed-defer",
      onDefer: {
        sendEmail: {
          schema: z.object({ to: z.string() }),
          handler: async () => {},
        },
        processPayment: {
          schema: z.object({ amount: z.number() }),
          handler: async () => {},
        },
      },
      triggers: [{ event: "test" }],
    },
    async ({ defer }) => {
      expectTypeOf(defer.sendEmail).toBeFunction();
      expectTypeOf(defer.processPayment).toBeFunction();

      expectTypeOf(defer.sendEmail).toBeCallableWith({ to: "a@b.com" });
      expectTypeOf(defer.processPayment).toBeCallableWith({ amount: 100 });
    },
  );
});

test("no defer when onDefer is absent", () => {
  const client = new Inngest({ id: "type-test-2", isDev: true });

  client.createFunction(
    {
      id: "no-defer",
      triggers: [{ event: "test" }],
    },
    async (ctx) => {
      expectTypeOf(ctx).not.toHaveProperty("defer");
    },
  );
});
