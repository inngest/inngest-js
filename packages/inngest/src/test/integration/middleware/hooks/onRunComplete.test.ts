import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  anyContext,
  createState,
  randomSuffix,
  testNameFromFileUrl,
} from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

describe("args", () => {
  for (const level of ["client", "function"] as const) {
    test(`level: ${level}`, async () => {
      const state = createState({
        hookArgs: [] as Middleware.OnRunCompleteArgs[],
      });

      class TestMiddleware extends Middleware.BaseMiddleware {
        override onRunComplete(args: Middleware.OnRunCompleteArgs) {
          state.hookArgs.push(args);
        }
      }

      let clientMiddleware: Middleware.Class[] = [];
      let functionMiddleware: Middleware.Class[] = [];
      if (level === "client") {
        clientMiddleware = [TestMiddleware];
      } else {
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
          return "fn result";
        },
      );
      await createTestApp({ client, functions: [fn] });

      await client.send({ name: eventName });
      await state.waitForRunComplete();

      expect(state.hookArgs).toEqual([
        {
          ctx: anyContext,
          functionInfo: { id: "fn" },
          output: "fn result",
        },
      ]);
    });
  }
});

test("with steps", async () => {
  const state = createState({
    calls: [] as Middleware.OnRunCompleteArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onRunComplete(args: Middleware.OnRunCompleteArgs) {
      state.calls.push(args);
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });

  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ step, runId }) => {
      await step.run("my-step", () => "step result");
      state.runId = runId;
      return "fn result";
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Only fires on the completing request (request 2), not on step discovery (request 1)
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toEqual({
    ctx: anyContext,
    functionInfo: { id: "fn" },
    output: "fn result",
  });
});

test("does NOT fire when function errors", async () => {
  const state = createState({
    endCalls: 0,
    errorCalls: 0,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onRunComplete() {
      state.endCalls++;
    }
    override onRunError() {
      state.errorCalls++;
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
      throw new Error("fn error");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunFailed();

  expect(state.endCalls).toBe(0);
  expect(state.errorCalls).toBe(1);
});

test("throws", async () => {
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const state = createState({
    hook: { count: 0 },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onRunComplete() {
      state.hook.count++;
      throw new Error("oh no");
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

  expect(state.hook).toEqual({ count: 1 });
  expect(consoleSpy).toHaveBeenCalledWith(
    {
      error: expect.any(Error),
      hook: "onRunComplete",
      mw: "TestMiddleware",
    },
    "middleware error",
  );

  consoleSpy.mockRestore();
});
