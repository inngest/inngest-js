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

test("fires when function throws", async () => {
  const state = createState({
    calls: [] as Middleware.OnRunErrorArgs[],
  });

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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId }) => {
      state.runId = runId;
      throw new MyError("fn error");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunFailed();

  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toEqual({
    ctx: anyContext,
    error: expect.any(MyError),
    isFinalAttempt: true,
  });

  const { error } = state.calls[0]!;
  expect(error.name).toBe("MyError");
  expect(error.message).toBe("fn error");
});

test("does NOT fire when function succeeds", async () => {
  const state = createState({
    count: 0,
  });

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

test("multiple attempts", async () => {
  const state = createState({
    attempts: 0,
    calls: [] as Middleware.OnRunErrorArgs[],
  });

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
    { id: "fn", retries: 1, triggers: [{ event: eventName }] },
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
    isFinalAttempt: false,
  });
  expect(state.calls[1]).toEqual({
    ctx: anyContext,
    error: expect.any(MyError),
    isFinalAttempt: true,
  });
});
