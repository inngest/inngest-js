import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import {
  anyContext,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

class MyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

test("1 step", async () => {
  const state = {
    done: false,
    calls: [] as Middleware.OnStepErrorArgs[],
  };

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
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      try {
        await step.run("my-step", () => {
          throw new MyError("my error");
        });
      } catch {}
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.calls).toEqual([
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
    },
  ]);
  const { error } = state.calls[0]!;
  expect(error.name).toBe("MyError");
  expect(error.message).toBe("my error");
});

test("multiple steps with errors", async () => {
  const state = {
    done: false,
    calls: [] as Middleware.OnStepErrorArgs[],
  };

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
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
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

      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.calls).toEqual([
    {
      error: expect.any(Error),
      ctx: anyContext,
      stepInfo: {
        hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
        input: undefined,
        memoized: false,
        options: { id: "step-1", name: "step-1" },
        stepKind: "run",
      },
    },
    {
      error: expect.any(Error),
      ctx: anyContext,
      stepInfo: {
        hashedId: "e64b25e67dec6c8d30e63029286ad7b6d263931d",
        input: undefined,
        memoized: false,
        options: { id: "step-2", name: "step-2" },
        stepKind: "run",
      },
    },
  ]);

  const step1Error = state.calls[0]!.error;
  expect(step1Error.message).toBe("error 1");
  expect(step1Error.name).toBe("MyError");

  const step2Error = state.calls[1]!.error;
  expect(step2Error.message).toBe("error 2");
  expect(step2Error.name).toBe("MyError");
});

test("no errors", async () => {
  const state = {
    count: 0,
    done: false,
  };

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
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      await step.run("step-1", () => "success");
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });
  expect(state.count).toEqual(0);
});
