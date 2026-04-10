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
              state.deferredData = event.data.data;
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
        await defer.process({ data: { msg } });
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
        "send-email": {
          schema: z.object({ to: z.string() }),
          handler: async ({ event, step }) => {
            await step.run("capture-email", () => {
              state.emailData = event.data.data;
            });
          },
        },
        "process-payment": {
          schema: z.object({ amount: z.number() }),
          handler: async ({ event, step }) => {
            await step.run("capture-payment", () => {
              state.paymentData = event.data.data;
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
        await defer["send-email"]({ data: { to: "a@b.com" } });
      });

      await step.run("process-payment", async () => {
        await defer["process-payment"]({ data: { amount: 100 } });
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

test("onDefer types: defer mirrors onDefer keys with typed methods", () => {
  const client = new Inngest({ id: "type-test", isDev: true });

  client.createFunction(
    {
      id: "typed-defer",
      onDefer: {
        "send-email": {
          schema: z.object({ to: z.string() }),
          handler: async () => {},
        },
        "process-payment": {
          schema: z.object({ amount: z.number() }),
          handler: async () => {},
        },
      },
      triggers: [{ event: "test" }],
    },
    async ({ defer }) => {
      expectTypeOf(defer["send-email"]).toBeFunction();
      expectTypeOf(defer["process-payment"]).toBeFunction();

      expectTypeOf(defer["send-email"]).toBeCallableWith({
        data: { to: "a@b.com" },
      });
      expectTypeOf(defer["process-payment"]).toBeCallableWith({
        data: { amount: 100 },
      });
    },
  );
});

test("onDefer types: no defer when onDefer is absent", () => {
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
