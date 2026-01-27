import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("transform result", async () => {
  const state = {
    done: false,
    transformedResults: [] as unknown[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformRunOutput(arg: Middleware.TransformRunOutputArgs) {
      state.transformedResults.push(arg.output);
      return { wrapped: arg.output };
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middlewareV2: [new TestMiddleware()],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async () => {
      state.done = true;
      return "original result";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.transformedResults).toEqual(["original result"]);
});

test("multiple middleware in correct order", async () => {
  const state = {
    done: false,
    logs: [] as string[],
  };

  class Mw1 extends Middleware.BaseMiddleware {
    override transformRunOutput(arg: Middleware.TransformRunOutputArgs) {
      state.logs.push(`mw1: ${arg.output}`);
      return `mw1(${arg.output})`;
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override transformRunOutput(arg: Middleware.TransformRunOutputArgs) {
      state.logs.push(`mw2: ${arg.output}`);
      return `mw2(${arg.output})`;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middlewareV2: [new Mw1(), new Mw2()],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async () => {
      state.done = true;
      return "result";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // Output transforms are called in forward order (mw1 first, then mw2)
  // Each sees the result from the previous middleware
  expect(state.logs).toEqual(["mw1: result", "mw2: mw1(result)"]);
});

test("not called on error", async () => {
  const state = {
    done: false,
    outputCalls: 0,
    errorCalls: 0,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformRunOutput() {
      state.outputCalls++;
      return "ignored";
    }
    override transformRunError(arg: Middleware.TransformRunErrorArgs) {
      state.errorCalls++;
      return arg.error;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middlewareV2: [new TestMiddleware()],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async () => {
      state.done = true;
      throw new Error("function error");
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.outputCalls).toBe(0);
  expect(state.errorCalls).toBe(1);
});
