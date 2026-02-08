import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  anyContext,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("fires when function completes with data", async () => {
  const state = {
    done: false,
    calls: [] as Middleware.OnRunEndArgs[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onRunEnd(args: Middleware.OnRunEndArgs) {
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
      await step.run("my-step", () => "step result");
      state.done = true;
      return "fn result";
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  // Only fires on the completing request (request 2), not on step discovery (request 1)
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toEqual({ ctx: anyContext, data: "fn result" });
});

test("does NOT fire when function errors", async () => {
  const state = {
    done: false,
    endCalls: 0,
    errorCalls: 0,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onRunEnd() {
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
    { id: "fn", retries: 0 },
    { event: eventName },
    async () => {
      state.done = true;
      throw new Error("fn error");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.endCalls).toBe(0);
  expect(state.errorCalls).toBe(1);
});

test("fires with no steps", async () => {
  const state = {
    done: false,
    calls: [] as Middleware.OnRunEndArgs[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onRunEnd(args: Middleware.OnRunEndArgs) {
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
      return "no-step result";
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toEqual({ ctx: anyContext, data: "no-step result" });
});
