import {
  createState,
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createServer } from "../../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("info hooks for parallel steps", async () => {
  const state = createState({
    logs: [] as string[],
    parallelSteps: {
      outputs: [] as unknown[],
    },
    step1: {
      insideCount: 0,
      output: "",
    },
    step2a: {
      insideCount: 0,
    },
    step3: {
      insideCount: 0,
      output: "",
    },
  });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "test";
    override onMemoizationEnd() {
      state.logs.push("onMemoizationEnd");
    }

    override onStepStart() {
      state.logs.push("onStepStart");
    }

    override onStepComplete() {
      state.logs.push("onStepComplete");
    }

    override onRunStart() {
      state.logs.push("onRunStart");
    }

    override onRunComplete() {
      state.logs.push("onRunComplete");
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      state.logs.push("fn: top");
      state.step1.output = await step.run("step-1", () => {
        state.step1.insideCount++;
        state.logs.push("step-1: inside");
        return "step-1: output";
      });

      state.parallelSteps.outputs = await Promise.all([
        step.run("step-2-a", () => {
          state.step2a.insideCount++;
          state.logs.push("step-2-a: inside");
          return "step-2-a: output";
        }),
        step.sleep("step-2-b", "1s"),
      ]);

      state.step3.output = await step.run("step-3", async () => {
        state.step3.insideCount++;
        state.logs.push("step-3: inside");

        // Sleep a little to avoid races in assertions. We can delete this when
        // we use optimized parallelism
        await sleep(500);

        return "step-3: output";
      });

      state.logs.push("fn: bottom");
    },
  );

  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.parallelSteps.outputs).toEqual(["step-2-a: output", null]);
  expect(state.step1).toEqual({
    insideCount: 1,
    output: "step-1: output",
  });
  expect(state.step2a).toEqual({
    insideCount: 1,
  });
  expect(state.step3).toEqual({
    insideCount: 1,
    output: "step-3: output",
  });

  expect(state.logs).toEqual([
    // 1st request
    "onMemoizationEnd",
    "onRunStart",
    "fn: top",
    "onStepStart",
    "step-1: inside",
    "onStepComplete",

    // 2nd request: target parallel step
    "fn: top",
    "onMemoizationEnd",
    "onStepStart",
    "step-2-a: inside",
    "onStepComplete",

    // 3rd request: target parallel step
    "fn: top",
    "onMemoizationEnd",

    // 4th request: target step-3
    "fn: top",
    "onMemoizationEnd",
    "onStepStart",
    "step-3: inside",
    "onStepComplete",

    // 5th request
    "fn: top",
    "onMemoizationEnd",
    "fn: bottom",
    "onRunComplete",
  ]);
});

test("wrapStep runs for every memoized sibling parallel step", async () => {
  // Regression test for a bug, where wrapStep wasn't respecting parallel steps.

  const state = createState({
    output: null as unknown,
  });

  class TagMiddleware extends Middleware.BaseMiddleware {
    readonly id = "tag";

    override async wrapStep({ next }: Middleware.WrapStepArgs) {
      await sleep(10);
      const value = await next();
      return { tagged: true, value };
    }
  }

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TagMiddleware],
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      const [a, b] = await Promise.all([
        step.run("step-a", () => ({ from: "a" })),
        step.run("step-b", () => ({ from: "b" })),
      ]);

      state.output = { a, b };
      state.runId = runId;
      return state.output;
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();

  const expected = {
    a: { tagged: true, value: { from: "a" } },
    b: { tagged: true, value: { from: "b" } },
  };
  expect(state.output).toEqual(expected);
  expect(result).toEqual(expected);
});
