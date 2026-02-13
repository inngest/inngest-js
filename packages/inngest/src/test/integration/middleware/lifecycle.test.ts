import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import {
  createState,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("state does not bleed between requests", async () => {
  const state = createState({
    counters: [] as number[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    counter = 0;

    override onStepStart() {
      this.counter++;
      state.counters.push(this.counter);
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
    },
  );

  await createTestApp({ client, functions: [fn] });

  // First invocation
  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Second invocation
  state.runId = null;
  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Each invocation should start counter from 0, so each push is 1
  // (not 1 then 2, which would happen if state bled across requests)
  for (const counter of state.counters) {
    expect(counter).toBe(1);
  }
});

test("each request gets a fresh instance", async () => {
  const state = createState({
    instances: [] as Middleware.BaseMiddleware[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart() {
      state.instances.push(this);
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
    },
  );

  await createTestApp({ client, functions: [fn] });

  // First invocation
  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Second invocation
  state.runId = null;
  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Each request should get a different middleware object instance
  expect(state.instances.length).toBeGreaterThanOrEqual(2);
  const unique = new Set(state.instances);
  expect(unique.size).toBe(state.instances.length);
});

test("middleware state is consistent within a single request", async () => {
  const state = createState({
    dataInWrap: null as string | null,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    data = "";

    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      this.data = "set-in-transform";
      return arg;
    }

    override async wrapFunctionHandler({
      next,
    }: Middleware.WrapFunctionHandlerArgs) {
      state.dataInWrap = this.data;
      return next();
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

  // The same instance was used throughout the request lifecycle
  expect(state.dataInWrap).toBe("set-in-transform");
});
