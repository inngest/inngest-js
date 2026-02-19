import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import { createState, randomSuffix, testNameFromFileUrl } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("called once for client middleware", async () => {
  const state = createState({
    count: 0,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    static override onRegister() {
      state.count++;
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

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Called once during client construction, not again per request
  expect(state.count).toBe(1);
});

test("called once for function middleware", async () => {
  const state = createState({
    count: 0,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    static override onRegister() {
      state.count++;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      middleware: [TestMiddleware],
      triggers: [{ event: eventName }],
    },
    async ({ runId }) => {
      state.runId = runId;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Called once during createFunction, not again per request
  expect(state.count).toBe(1);
});

test("receives the client instance", async () => {
  const state = createState({
    receivedClient: null as Inngest.Any | null,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    static override onRegister(arg: Middleware.OnRegisterArgs) {
      state.receivedClient = arg.client;
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

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.receivedClient).toBe(client);
});

test("called for both client and function middleware", async () => {
  const state = createState({
    logs: [] as string[],
  });

  class ClientMW extends Middleware.BaseMiddleware {
    static override onRegister() {
      state.logs.push("client");
    }
  }

  class FunctionMW extends Middleware.BaseMiddleware {
    static override onRegister() {
      state.logs.push("function");
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [ClientMW],
  });

  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      middleware: [FunctionMW],
      triggers: [{ event: eventName }],
    },
    async ({ runId }) => {
      state.runId = runId;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.logs).toEqual(["client", "function"]);
});
