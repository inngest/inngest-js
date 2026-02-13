import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  createState,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
  waitFor,
} from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("receives request info", async () => {
  const state = createState({
    hookArgs: [] as Middleware.WrapRequestArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override wrapRequest: Middleware.BaseMiddleware["wrapRequest"] = async (
      next,
      { requestInfo },
    ) => {
      state.hookArgs.push({ requestInfo });
      return next();
    };
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
    override async wrapRequest(): Promise<Middleware.Response> {
      throw new Error("request rejected");
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
  const state = createState({
    response: null as Middleware.Response | null,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override async wrapRequest(next: () => Promise<Middleware.Response>) {
      const res = await next();
      console.log(res);
      state.response = res;
      return res;
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
      return "output";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.response).toEqual({
    status: 200,
    headers: expect.any(Object),
    body: expect.any(String),
  });
  expect(state.response!.headers["Content-Type"]).toBe("application/json");
  expect(state.response!.body).toBe(JSON.stringify("output"));
});

test("multiple middleware in onion order", async () => {
  const state = createState({
    logs: [] as string[],
  });

  class Mw1 extends Middleware.BaseMiddleware {
    override async wrapRequest(next: () => Promise<Middleware.Response>) {
      state.logs.push("mw1: before");
      const result = await next();
      state.logs.push("mw1: after");
      return result;
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override async wrapRequest(next: () => Promise<Middleware.Response>) {
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

describe("throws", () => {
  test("in hook", async () => {
    // Errors in the hook reject the request; function never runs

    const state = {
      fn: { count: 0 },
      hook: { count: 0 },
    };

    class TestMiddleware extends Middleware.BaseMiddleware {
      override wrapRequest = async () => {
        state.hook.count++;
        throw new Error("oh no");
      };
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [TestMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async () => {
        state.fn.count++;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await sleep(3000);

    expect(state.fn).toEqual({ count: 0 });
    expect(state.hook.count).toBeGreaterThanOrEqual(1);
  });

  test("in function", async () => {
    // Errors in the function are captured in the response

    const state = createState({
      fn: { count: 0 },
      hook: { count: 0 },
    });

    class TestMiddleware extends Middleware.BaseMiddleware {
      override wrapRequest = async (
        next: () => Promise<Middleware.Response>,
      ) => {
        state.hook.count++;
        return next();
      };
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
        state.fn.count++;
        throw new Error("oh no");
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunFailed();

    expect(state.fn).toEqual({ count: 1 });
    expect(state.hook.count).toBeGreaterThanOrEqual(1);
  });
});
