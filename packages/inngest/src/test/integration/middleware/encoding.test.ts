import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

// Helper functions for base64 encoding/decoding
function encode(value: unknown): unknown {
  try {
    return Buffer.from(JSON.stringify(value)).toString("base64");
  } catch {
    return value;
  }
}

function decode(encoded: unknown): unknown {
  if (typeof encoded !== "string") {
    return encoded;
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  } catch {
    return encoded;
  }
}

test("base64 encoding/decoding middleware", async () => {
  const state = {
    done: false,
    step1Outputs: [] as unknown[],
    step2Outputs: [] as unknown[],
    transformRunCalls: [] as Middleware.RunInfo[],
  };

  class EncodingMiddleware extends Middleware.BaseMiddleware {
    override transformRun(
      handler: () => Promise<unknown>,
      runInfo: Middleware.RunInfo,
    ) {
      // Deep clone runInfo BEFORE decoding to capture the encoded state
      state.transformRunCalls.push(JSON.parse(JSON.stringify(runInfo)));

      // Decode all memoized step data before function runs
      for (const [id, stepData] of Object.entries(runInfo.steps)) {
        if (stepData?.type === "data" && typeof stepData.data === "string") {
          runInfo.steps[id] = {
            data: decode(stepData.data),
            type: "data",
          };
        }
      }
      return handler();
    }

    override async transformStep(
      handler: () => Promise<unknown>,
      runInfo: Middleware.RunInfo,
      stepInfo: Middleware.StepInfo,
    ) {
      if (stepInfo.memoized) {
        return handler();
      }

      return encode(await handler());
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middlewareV2: [new EncodingMiddleware()],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      const step1Output = await step.run("step-1", () => {
        return { message: "hello", count: 42 };
      });
      state.step1Outputs.push(step1Output);

      const step2Output = await step.run("step-2", () => {
        return ["a", "b", "c"];
      });
      state.step2Outputs.push(step2Output);

      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 10000);

  const expectedRunInfo = {
    attempt: 0,
    event: expect.any(Object),
    events: [expect.any(Object)],
    runId: expect.any(String),
    steps: {},
  };
  expect(state.transformRunCalls.slice(0, 2)).toEqual([
    expectedRunInfo,
    {
      ...expectedRunInfo,
      steps: {
        cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa: {
          data: encode({ message: "hello", count: 42 }),
          type: "data",
        },
      },
    },
  ]);

  expect(state.step1Outputs).toEqual([
    { message: "hello", count: 42 },
    { message: "hello", count: 42 },
  ]);
  expect(state.step2Outputs).toEqual([["a", "b", "c"]]);
});
