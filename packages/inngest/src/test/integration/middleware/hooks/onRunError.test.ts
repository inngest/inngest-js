import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  anyContext,
  createState,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

class MyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

describe("args", () => {
  for (const level of ["client", "function"] as const) {
    test(`level: ${level}`, async () => {
      const state = createState({
        hookArgs: [] as Middleware.OnRunErrorArgs[],
      });

      class TestMiddleware extends Middleware.BaseMiddleware {
        readonly id = "test";
        override onRunError(args: Middleware.OnRunErrorArgs) {
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
          throw new MyError("fn error");
        },
      );

      await createTestApp({ client, functions: [fn] });

      await client.send({ name: eventName });
      await state.waitForRunFailed();

      expect(state.hookArgs).toEqual([
        {
          ctx: anyContext,
          error: expect.any(MyError),
          fn,
          isFinalAttempt: true,
        },
      ]);
    });
  }
});

test("multiple attempts", async () => {
  const state = createState({
    attempts: 0,
    calls: [] as Middleware.OnRunErrorArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override onRunError(args: Middleware.OnRunErrorArgs) {
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
      retries: 1,
      triggers: [{ event: eventName }],
    },
    async ({ runId }) => {
      state.runId = runId;
      state.attempts++;
      throw new MyError("fn error");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.attempts).toBe(2);
  });

  expect(state.calls).toHaveLength(2);
  expect(state.calls[0]).toEqual({
    ctx: anyContext,
    error: expect.any(MyError),
    fn,
    isFinalAttempt: false,
  });
  expect(state.calls[1]).toEqual({
    ctx: anyContext,
    error: expect.any(MyError),
    fn,
    isFinalAttempt: true,
  });
});

test("does NOT fire when function succeeds", async () => {
  const state = createState({
    count: 0,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override onRunError() {
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
    async ({ step, runId }) => {
      state.runId = runId;
      await step.run("my-step", () => "result");
      return "ok";
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.count).toBe(0);
});

test("fires when function throws after steps complete", async () => {
  const state = createState({
    calls: [] as Middleware.OnRunErrorArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override onRunError(args: Middleware.OnRunErrorArgs) {
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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      await step.run("my-step", () => "result");
      throw new MyError("after steps");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunFailed();

  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]!.error.message).toBe("after steps");
  expect(state.calls[0]!.isFinalAttempt).toBe(true);
});

test("throws", async () => {
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const state = createState({
    hook: { count: 0 },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override onRunError() {
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
      throw new Error("fn error");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunFailed();

  expect(state.hook).toEqual({ count: 1 });
  expect(consoleSpy).toHaveBeenCalledWith("middleware error");
  expect(consoleSpy).toHaveBeenCalledWith(expect.any(Error));
  expect(consoleSpy).toHaveBeenCalledWith({
    hook: "onRunError",
    mw: "test",
  });

  consoleSpy.mockRestore();
});
