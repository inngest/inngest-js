import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, sleep, testNameFromFileUrl, waitFor } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("receives request info", async () => {
  const state = {
    done: false,
    hookArgs: [] as Middleware.WrapRequestArgs[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override wrapRequest({
      requestInfo,
    }: Middleware.WrapRequestArgs): Middleware.WrapRequestReturn {
      state.hookArgs.push({ requestInfo });
      return async ({ next }) => {
        return next();
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
    { id: "fn", retries: 0 },
    { event: eventName },
    async () => {
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.hookArgs.length).toBe(1);
  const hookArgs = state.hookArgs[0]!;
  expect(hookArgs).toEqual({
    requestInfo: {
      body: expect.any(Function),
      headers: expect.any(Object),
      method: "POST",
      url: expect.any(URL),
    },
  });

  console.log(await hookArgs.requestInfo.body());
});

test("throwing rejects the request", async () => {
  const state = {
    fnCalled: false,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override wrapRequest(): Middleware.WrapRequestReturn {
      return async () => {
        throw new Error("request rejected");
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
    { id: "fn", retries: 0 },
    { event: eventName },
    async () => {
      state.fnCalled = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });

  // Wait enough time for the function to have potentially been called
  await sleep(3000);

  expect(state.fnCalled).toBe(false);
});

test("next() resolves with response", async () => {
  const state = {
    done: false,
    response: null as Middleware.Response | null,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override wrapRequest(): Middleware.WrapRequestReturn {
      return async ({ next }) => {
        const res = await next();
        console.log(res);
        state.response = res;
        return res;
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
    { id: "fn", retries: 0 },
    { event: eventName },
    async () => {
      state.done = true;
      return "output";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.response).toEqual({
    status: 200,
    headers: expect.any(Object),
    body: expect.any(String),
  });
  expect(state.response!.headers["Content-Type"]).toBe("application/json");
  expect(state.response!.body).toBe(JSON.stringify("output"));
});

test("multiple middleware in onion order", async () => {
  const state = {
    done: false,
    logs: [] as string[],
  };

  class Mw1 extends Middleware.BaseMiddleware {
    override wrapRequest(): Middleware.WrapRequestReturn {
      return async ({ next }) => {
        state.logs.push("mw1: before");
        const result = await next();
        state.logs.push("mw1: after");
        return result;
      };
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override wrapRequest(): Middleware.WrapRequestReturn {
      return async ({ next }) => {
        state.logs.push("mw2: before");
        const result = await next();
        state.logs.push("mw2: after");
        return result;
      };
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [Mw1, Mw2],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async () => {
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  // Filter to just the first set of wrap request logs (first execution)
  const wrapRequestLogs = state.logs.filter(
    (l) => l.startsWith("mw1:") || l.startsWith("mw2:"),
  );
  expect(wrapRequestLogs.slice(0, 4)).toEqual([
    "mw1: before",
    "mw2: before",
    "mw2: after",
    "mw1: after",
  ]);
});
