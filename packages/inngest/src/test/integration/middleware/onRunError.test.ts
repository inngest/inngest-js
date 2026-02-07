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

test("fires when function throws", async () => {
  const state = {
    done: false,
    calls: [] as Middleware.OnRunErrorArgs[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
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
    { id: "fn", retries: 0 },
    { event: eventName },
    async () => {
      state.done = true;
      throw new MyError("fn error");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toEqual({
    ctx: anyContext,
    error: expect.any(MyError),
  });

  const { error } = state.calls[0]!;
  expect(error.name).toBe("MyError");
  expect(error.message).toBe("fn error");
});

test("does NOT fire when function succeeds", async () => {
  const state = {
    done: false,
    count: 0,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
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
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      await step.run("my-step", () => "result");
      state.done = true;
      return "ok";
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.count).toBe(0);
});

test("fires when function throws after steps complete", async () => {
  const state = {
    done: false,
    calls: [] as Middleware.OnRunErrorArgs[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
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
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      await step.run("my-step", () => "result");
      state.done = true;
      throw new MyError("after steps");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]!.error.message).toBe("after steps");
});
