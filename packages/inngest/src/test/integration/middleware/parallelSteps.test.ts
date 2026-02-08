import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl, waitFor } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("info hooks for parallel steps", async () => {
  const state = {
    done: false,
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
    step2b: {
      insideCount: 0,
    },
    step3: {
      insideCount: 0,
      output: "",
    }
  };

    class MW extends Middleware.BaseMiddleware {
      override onMemoizationEnd() {
        state.logs.push("onMemoizationEnd");
      }

      override onStepStart() {
        state.logs.push("onStepStart");
      }

      override onStepEnd() {
        state.logs.push("onStepEnd");
      }

      override onRunStart() {
        state.logs.push("onRunStart");
      }

      override onRunEnd() {
        state.logs.push("onRunEnd");
      }
    };


  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
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
        step.run("step-2-b", () => {
          state.step2b.insideCount++;
          state.logs.push("step-2-b: inside");
          return "step-2-b: output";
        }),
        step.sleep("step-2-c", "1s"),
      ]);

      state.step3.output = await step.run("step-3", () => {
        state.step3.insideCount++;
        state.logs.push("step-3: inside");
        return "step-3: output";
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

  expect(state.parallelSteps.outputs).toEqual([
    "step-2-a: output",
    "step-2-b: output",
    null,
  ]);
  expect(state.step1).toEqual({
    insideCount: 1,
    output: "step-1: output",
  });
  expect(state.step2a).toEqual({
    insideCount: 1,
  });
  expect(state.step2b).toEqual({
    insideCount: 1,
  });
  expect(state.step3).toEqual({
    insideCount: 1,
    output: "step-3: output",
  });

  expect(state.logs).toEqual([
    // 1st request
    'onRunStart',
    'onMemoizationEnd',
    'fn: top',
    'onStepStart',
    'step-1: inside',
    'onStepEnd',

    // 2nd request
    'fn: top',
    'onMemoizationEnd',

    // 3rd request: target parallel step
    'fn: top',
    'onMemoizationEnd',
    'onStepStart',
    'step-2-a: inside',
    'onStepEnd',

    // 4th request: target parallel step
    'fn: top',
    'onMemoizationEnd',
    'onStepStart',
    'step-2-b: inside',
    'onStepEnd',

    // 5th request: post-parallel discovery
    'fn: top',
    'onMemoizationEnd',

    // 6th request: post-parallel discovery
    'fn: top',
    'onMemoizationEnd',

    // 7th request: post-parallel discovery
    'fn: top',
    'onMemoizationEnd',

    // 8th request: target step-3
    'fn: top',
    'onMemoizationEnd',
    'onStepStart',
    'step-3: inside',
    'onStepEnd',

    // 9th request
    'fn: top',
    'onMemoizationEnd',
    'fn: bottom',
    'onRunEnd'
  ]);
});
