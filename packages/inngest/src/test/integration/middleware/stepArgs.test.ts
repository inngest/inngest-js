import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("access step args via stepInfo.input", async () => {
  const state = {
    done: false,
    capturedInputFromOnStepStart: undefined as unknown[] | undefined,
    capturedInputFromTransformStepInput: undefined as unknown[] | undefined,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart({ stepInfo }: Middleware.OnStepStartArgs) {
      state.capturedInputFromOnStepStart = stepInfo.input;
    }

    override transformStepInput(arg: Middleware.TransformStepInputArgs) {
      state.capturedInputFromTransformStepInput = arg.stepInfo.input;
      return arg;
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
      await step.run(
        "my-step",
        (arg1: string, arg2: number) => {
          return `${arg1}-${arg2}`;
        },
        "hello",
        42,
      );
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.capturedInputFromOnStepStart).toEqual(["hello", 42]);
  expect(state.capturedInputFromTransformStepInput).toEqual(["hello", 42]);
});

test("step without args has undefined input", async () => {
  const state = {
    done: false,
    capturedInput: "not-set" as unknown,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart({ stepInfo }: Middleware.OnStepStartArgs) {
      state.capturedInput = stepInfo.input;
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
      await step.run("my-step", () => "result");
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.capturedInput).toBeUndefined();
});

test("multiple args of different types", async () => {
  const state = {
    done: false,
    capturedInput: undefined as unknown[] | undefined,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart({ stepInfo, runInfo }: Middleware.OnStepStartArgs) {
      state.capturedInput = stepInfo.input;
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
      await step.run(
        "my-step",
        (
          str: string,
          num: number,
          bool: boolean,
          obj: { key: string },
          arr: number[],
        ) => {
          return "result";
        },
        "text",
        123,
        true,
        { key: "value" },
        [1, 2, 3],
      );
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.capturedInput).toEqual([
    "text",
    123,
    true,
    { key: "value" },
    [1, 2, 3],
  ]);
});

test("change step arg", async () => {
  const state = {
    done: false,
    capturedInputFromOnStepStart: undefined as unknown[] | undefined,
    capturedInputFromTransformStepInput: undefined as unknown[] | undefined,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart({ stepInfo }: Middleware.OnStepStartArgs) {
      state.capturedInputFromOnStepStart = stepInfo.input;
    }

    override transformStepInput(arg: Middleware.TransformStepInputArgs) {
      state.capturedInputFromTransformStepInput = arg.stepInfo.input;
      arg.stepInfo.input = ["modified"];
      return arg;
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
      await step.run(
        "my-step",
        (value: string) => {
          return value;
        },
        "original",
      );
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // Modified because `onStepStart` runs after `transformStepInput`
  expect(state.capturedInputFromOnStepStart).toEqual(["modified"]);

  expect(state.capturedInputFromTransformStepInput).toEqual(["original"]);
});
