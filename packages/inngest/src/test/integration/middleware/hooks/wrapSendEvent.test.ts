import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import { createState, randomSuffix, testNameFromFileUrl } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("multiple middleware in onion order", async () => {
  const state = createState({
    logs: [] as string[],
  });

  class Mw1 extends Middleware.BaseMiddleware {
    override async wrapSendEvent({ next }: Middleware.WrapSendEventArgs) {
      state.logs.push("mw1: before");
      const result = await next();
      state.logs.push("mw1: after");
      return result;
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override async wrapSendEvent({ next }: Middleware.WrapSendEventArgs) {
      state.logs.push("mw2: before");
      const result = await next();
      state.logs.push("mw2: after");
      return result;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [Mw1, Mw2],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId }) => {
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.logs).toEqual([
    "mw1: before",
    "mw2: before",
    "mw2: after",
    "mw1: after",
  ]);
});

test("can modify output", async () => {
  const state = createState({
    output: null as { ids: string[] } | null,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override async wrapSendEvent({ next }: Middleware.WrapSendEventArgs) {
      const result = await next();
      return {
        ids: result.ids.map((id) => `${id}-modified`),
      };
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId }) => {
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  state.output = await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.output).toBeDefined();
  for (const id of state.output!.ids) {
    expect(id).toMatch(/-modified$/);
  }
});

test("receives events in args", async () => {
  const state = createState({
    receivedEvents: null as unknown,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override async wrapSendEvent({
      events,
      next,
    }: Middleware.WrapSendEventArgs) {
      state.receivedEvents = events;
      return next();
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId }) => {
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName, data: { hello: "world" } });
  await state.waitForRunComplete();

  expect(state.receivedEvents).toEqual([
    expect.objectContaining({ name: eventName, data: { hello: "world" } }),
  ]);
});

test("throwing rejects the send", async () => {
  class TestMiddleware extends Middleware.BaseMiddleware {
    override async wrapSendEvent({ next }: Middleware.WrapSendEventArgs) {
      throw new Error("send rejected");
      return next();
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async () => {},
  );
  await createTestApp({ client, functions: [fn] });

  await expect(client.send({ name: eventName })).rejects.toThrow(
    "send rejected",
  );
});
