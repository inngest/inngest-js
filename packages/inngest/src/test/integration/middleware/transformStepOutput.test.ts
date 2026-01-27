import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("transform step result", async () => {
  const state = {
    done: false,
    transformedResults: [] as unknown[],
    finalStepResult: null as unknown,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformStepOutput(arg: Middleware.TransformStepOutputArgs) {
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
    async ({ step }) => {
      state.finalStepResult = await step.run("my-step", async () => {
        return "original result";
      });
      state.done = true;
      return "function result";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // transformStepOutput is called when memoized step data is read
  expect(state.transformedResults).toEqual(["original result"]);
  expect(state.finalStepResult).toEqual({ wrapped: "original result" });
});

test("multiple middleware in correct order (forward piping)", async () => {
  const state = {
    done: false,
    logs: [] as string[],
    finalResult: null as unknown,
  };

  class Mw1 extends Middleware.BaseMiddleware {
    override transformStepOutput(arg: Middleware.TransformStepOutputArgs) {
      state.logs.push(`mw1: ${arg.output}`);
      return `mw1(${arg.output})`;
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override transformStepOutput(arg: Middleware.TransformStepOutputArgs) {
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
    async ({ step }) => {
      state.finalResult = await step.run("my-step", async () => "result");
      state.done = true;
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
  expect(state.finalResult).toBe("mw2(mw1(result))");
});

test("not called on step error", async () => {
  const state = {
    done: false,
    outputCalls: 0,
    errorCalls: 0,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformStepOutput() {
      state.outputCalls++;
      return "ignored";
    }
    override transformStepError(arg: Middleware.TransformStepErrorArgs) {
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
    async ({ step }) => {
      try {
        await step.run("failing-step", async () => {
          throw new Error("step error");
        });
      } catch {
        // Expected error
      }
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // On error, transformStepError is called, not transformStepOutput
  expect(state.outputCalls).toBe(0);
  expect(state.errorCalls).toBe(1);
});
