import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import { createState, randomSuffix, testNameFromFileUrl } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("no steps", async () => {
  const state = createState({
    logs: [] as string[],
  });

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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId }) => {
      state.runId = runId;
      state.logs.push("fn: top");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.logs).toEqual(["mw", "fn: top"]);
});

test("1 step", async () => {
  const state = createState({
    logs: [] as string[],
  });

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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      state.logs.push("fn: top");
      await step.run("my-step", () => {
        state.logs.push("step: inside");
      });
      state.logs.push("fn: bottom");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

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
  const state = createState({
    logs: [] as string[],
  });

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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      state.logs.push("fn: top");
      await step.run("step-1", () => {
        state.logs.push("step-1: inside");
      });
      state.logs.push("fn: between steps");
      await step.run("step-2", () => {
        state.logs.push("step-2: inside");
      });
      state.logs.push("fn: bottom");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

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

test("throws", async () => {
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const state = createState({
    hook: { count: 0 },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onMemoizationEnd() {
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
  expect(consoleSpy).toHaveBeenCalledWith("middleware error");
  expect(consoleSpy).toHaveBeenCalledWith(expect.any(Error));
  expect(consoleSpy).toHaveBeenCalledWith({
    hook: "onMemoizationEnd",
    mw: "TestMiddleware",
  });

  consoleSpy.mockRestore();
});
