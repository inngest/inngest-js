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

test("fires once per run (not on memoized requests)", async () => {
  const state = {
    done: false,
    count: 0,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onRunStart(args: Middleware.OnRunStartArgs) {
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
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.count).toEqual(1);
});

test("fires even when function errors", async () => {
  const state = {
    done: false,
    count: 0,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onRunStart() {
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

  expect(state.count).toBe(1);
});

test("fires with no steps", async () => {
  const state = {
    done: false,
    count: 0,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onRunStart() {
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
    async () => {
      state.done = true;
      return "hello";
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  // No steps = 1 request = 1 call
  expect(state.count).toBe(1);
});
