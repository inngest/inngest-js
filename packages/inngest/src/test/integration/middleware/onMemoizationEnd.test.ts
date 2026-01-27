import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl, waitFor } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("no steps", async () => {
  const state = {
    done: false,
    logs: [] as string[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onMemoizationEnd() {
      state.logs.push("mw");
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
      state.logs.push("fn: top");
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.logs).toEqual(["mw", "fn: top"]);
});

test("1 step", async () => {
  const state = {
    done: false,
    logs: [] as string[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onMemoizationEnd() {
      state.logs.push("mw");
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
      state.logs.push("fn: top");
      await step.run("my-step", () => {
        state.logs.push("step: inside");
      });
      state.logs.push("fn: bottom");
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.logs).toEqual([
    // 1st request
    "mw",
    "fn: top",
    "step: inside",

    // 3rd request
    "fn: top",
    "mw",
    "fn: bottom",
  ]);
});

test("2 steps", async () => {
  const state = {
    done: false,
    logs: [] as string[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onMemoizationEnd() {
      state.logs.push("mw");
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
      state.logs.push("fn: top");
      await step.run("step-1", () => {
        state.logs.push("step-1: inside");
      });
      state.logs.push("fn: between steps");
      await step.run("step-2", () => {
        state.logs.push("step-2: inside");
      });
      state.logs.push("fn: bottom");
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.logs).toEqual([
    // 1st request
    "mw",
    "fn: top",
    "step-1: inside",

    // 2nd request
    "fn: top",
    "mw",
    "fn: between steps",
    "step-2: inside",

    // 3rd request
    "fn: top",
    "fn: between steps",
    "mw",
    "fn: bottom",
  ]);
});
