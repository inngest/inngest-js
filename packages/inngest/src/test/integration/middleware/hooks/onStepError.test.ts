import { expect, test } from "vitest";
import { Inngest, Middleware, StepError } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  anyContext,
  createState,
  randomSuffix,
  testNameFromFileUrl,
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
        hookArgs: [] as Middleware.OnStepErrorArgs[],
      });

      class TestMiddleware extends Middleware.BaseMiddleware {
        override onStepError(args: Middleware.OnStepErrorArgs) {
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
        async ({ step, runId }) => {
          state.runId = runId;
          try {
            await step.run("my-step", () => {
              throw new MyError("my error");
            });
          } catch {}
        },
      );

      await createTestApp({ client, functions: [fn] });

      await client.send({ name: eventName });
      await state.waitForRunComplete();

      expect(state.hookArgs).toEqual([
        {
          stepInfo: {
            hashedId: "8376129f22207d6e1acaa1c92de099dcb1ba24db",
            input: undefined,
            memoized: false,
            options: { id: "my-step", name: "my-step" },
            stepKind: "run",
          },
          ctx: anyContext,
          error: expect.any(MyError),
          functionInfo: { id: "fn" },
          isFinalAttempt: true,
        },
      ]);
    });
  }
});

test("multiple steps with errors", async () => {
  const state = createState({
    calls: [] as Middleware.OnStepErrorArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepError(args: Middleware.OnStepErrorArgs) {
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
      state.runId = runId;
      try {
        await step.run("step-1", () => {
          throw new MyError("error 1");
        });
      } catch {}

      try {
        await step.run("step-2", () => {
          throw new MyError("error 2");
        });
      } catch {}
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.calls).toEqual([
    {
      error: expect.any(Error),
      ctx: anyContext,
      functionInfo: { id: "fn" },
      stepInfo: {
        hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
        input: undefined,
        memoized: false,
        options: { id: "step-1", name: "step-1" },
        stepKind: "run",
      },
      isFinalAttempt: true,
    },
    {
      error: expect.any(Error),
      ctx: anyContext,
      functionInfo: { id: "fn" },
      stepInfo: {
        hashedId: "e64b25e67dec6c8d30e63029286ad7b6d263931d",
        input: undefined,
        memoized: false,
        options: { id: "step-2", name: "step-2" },
        stepKind: "run",
      },
      isFinalAttempt: true,
    },
  ]);

  const step1Error = state.calls[0]!.error;
  expect(step1Error.message).toBe("error 1");
  expect(step1Error.name).toBe("MyError");

  const step2Error = state.calls[1]!.error;
  expect(step2Error.message).toBe("error 2");
  expect(step2Error.name).toBe("MyError");
});

test("multiple attempts", async () => {
  const state = createState({
    calls: [] as Middleware.OnStepErrorArgs[],
    caughtError: null as unknown,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepError(args: Middleware.OnStepErrorArgs) {
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
    async ({ step, runId }) => {
      state.runId = runId;
      try {
        await step.run("my-step", () => {
          throw new MyError("my error");
        });
      } catch (err) {
        state.caughtError = err;
      }
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.calls).toHaveLength(2);
  expect(state.calls[0]).toEqual({
    stepInfo: {
      hashedId: "8376129f22207d6e1acaa1c92de099dcb1ba24db",
      input: undefined,
      memoized: false,
      options: { id: "my-step", name: "my-step" },
      stepKind: "run",
    },
    ctx: anyContext,
    error: expect.any(MyError),
    functionInfo: { id: "fn" },
    isFinalAttempt: false,
  });
  expect(state.calls[1]).toEqual({
    stepInfo: {
      hashedId: "8376129f22207d6e1acaa1c92de099dcb1ba24db",
      input: undefined,
      memoized: false,
      options: { id: "my-step", name: "my-step" },
      stepKind: "run",
    },
    ctx: anyContext,
    error: expect.any(MyError),
    functionInfo: { id: "fn" },
    isFinalAttempt: true,
  });
  const { error } = state.calls[0]!;
  expect(error.name).toBe("MyError");
  expect(error.message).toBe("my error");
});

test("no errors", async () => {
  const state = createState({
    count: 0,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepError() {
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
      await step.run("step-1", () => "success");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();
  expect(state.count).toEqual(0);
});

test("throws", async () => {
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const state = createState({
    hook: { count: 0 },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepError() {
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
    async ({ step, runId }) => {
      state.runId = runId;
      try {
        await step.run("my-step", () => {
          throw new Error("step error");
        });
      } catch {}
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.hook).toEqual({ count: 1 });
  expect(consoleSpy).toHaveBeenCalledWith(
    {
      error: expect.any(Error),
      hook: "onStepError",
      mw: "TestMiddleware",
    },
    "middleware error",
  );

  consoleSpy.mockRestore();
});
