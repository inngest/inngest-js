import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

class OriginalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

class WrappedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

test("transform error", async () => {
  const state = {
    done: false,
    capturedErrors: [] as Error[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformRunError(arg: Middleware.TransformRunErrorArgs) {
      state.capturedErrors.push(arg.error);
      return new WrappedError("wrapped", { cause: arg.error });
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
      throw new OriginalError("original");
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.capturedErrors).toHaveLength(1);
  expect(state.capturedErrors[0]).toBeInstanceOf(OriginalError);
  expect(state.capturedErrors[0]!.message).toBe("original");
});

test("multiple middleware in correct order", async () => {
  const state = {
    done: false,
    logs: [] as string[],
  };

  class Mw1 extends Middleware.BaseMiddleware {
    override transformRunError(arg: Middleware.TransformRunErrorArgs) {
      state.logs.push(`mw1: ${arg.error.message}`);
      return new Error(`mw1(${arg.error.message})`);
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override transformRunError(arg: Middleware.TransformRunErrorArgs) {
      state.logs.push(`mw2: ${arg.error.message}`);
      return new Error(`mw2(${arg.error.message})`);
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
      throw new Error("error");
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // Error transforms are called in forward order (mw1 first, then mw2)
  // Each sees the error from the previous middleware
  expect(state.logs).toEqual(["mw1: error", "mw2: mw1(error)"]);
});

test("not called on success", async () => {
  const state = {
    done: false,
    outputCalls: 0,
    errorCalls: 0,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformRunOutput(arg: Middleware.TransformRunOutputArgs) {
      state.outputCalls++;
      return arg.output;
    }
    override transformRunError() {
      state.errorCalls++;
      return new Error("ignored");
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
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.outputCalls).toBe(1);
  expect(state.errorCalls).toBe(0);
});
