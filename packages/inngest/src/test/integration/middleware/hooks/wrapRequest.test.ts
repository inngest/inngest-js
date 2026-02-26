import {
  createState,
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

describe("args", () => {
  for (const level of ["client", "function"] as const) {
    test(`level: ${level}`, async () => {
      const state = createState({
        hookArgs: [] as Omit<Middleware.WrapRequestArgs, "next">[],
      });

      class TestMiddleware extends Middleware.BaseMiddleware {
        readonly id = "test";
        override wrapRequest = async ({
          next,
          fn,
          requestInfo,
          runId,
        }: Middleware.WrapRequestArgs) => {
          state.hookArgs.push({ fn, requestInfo, runId });
          return next();
        };
      }

      let clientMiddleware: Middleware.Class[] = [];
      let functionMiddleware: Middleware.Class[] = [];
      if (level === "client") {
        clientMiddleware = [TestMiddleware];
      } else if (level === "function") {
        functionMiddleware = [TestMiddleware];
      }

      const eventName = randomSuffix("evt");
      const client = new Inngest({
        id: randomSuffix(testFileName),
        isDev: true,
        middleware: clientMiddleware,
      });
      const fn = client.createFunction(
        {
          id: "fn",
          retries: 0,
          middleware: functionMiddleware,
          triggers: [{ event: eventName }],
        },
        async ({ runId }) => {
          state.runId = runId;
        },
      );
      await createTestApp({ client, functions: [fn] });

      await client.send({ name: eventName });
      await state.waitForRunComplete();

      expect(state.hookArgs).toEqual([
        {
          fn,
          requestInfo: {
            body: expect.any(Function),
            headers: expect.any(Object),
            method: "POST",
            url: expect.any(URL),
          },
          runId: state.runId,
        },
      ]);
    });
  }
});

test("throwing rejects the request", async () => {
  const state = createState({
    fnCalled: false,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapRequest({
      runId,
    }: Middleware.WrapRequestArgs): Promise<Middleware.Response> {
      state.runId = runId;
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
  await state.waitForRunFailed();

  expect(state.fnCalled).toBe(false);
});

test("next() resolves with response", async () => {
  const state = createState({
    response: null as Middleware.Response | null,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapRequest({ next }: Middleware.WrapRequestArgs) {
      const res = await next();
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
    status: 206,
    headers: expect.any(Object),
    body: expect.any(String),
  });
  expect(state.response!.headers["Content-Type"]).toBe("application/json");
  expect(state.response!.body).toBe(
    JSON.stringify([
      {
        op: "RunComplete",
        id: "0737c22d3bfae812339732d14d8c7dbd6dc4e09c",
        data: "output",
      },
    ]),
  );
});

test("multiple middleware in onion order", async () => {
  const state = createState({
    logs: [] as string[],
  });

  class Mw1 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapRequest({ next }: Middleware.WrapRequestArgs) {
      state.logs.push("mw1: before");
      const result = await next();
      state.logs.push("mw1: after");
      return result;
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapRequest({ next }: Middleware.WrapRequestArgs) {
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

    const state = createState({
      fn: { count: 0 },
      hook: { count: 0 },
    });

    class TestMiddleware extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapRequest({ next, runId }: Middleware.WrapRequestArgs) {
        state.runId = runId;
        state.hook.count++;
        throw new Error("oh no");
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
      async () => {
        state.fn.count++;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunFailed();

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
      readonly id = "test";
      override wrapRequest({ next }: Middleware.WrapRequestArgs) {
        state.hook.count++;
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
