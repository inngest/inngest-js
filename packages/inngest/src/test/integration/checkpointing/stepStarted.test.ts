import {
  createState,
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, onTestFinished, test } from "vitest";
import { isRecord } from "../../../helpers/types.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import { StepOpCode } from "../../../types.ts";
import {
  createRecordingDevServerProxy,
  type RecordedRequest,
} from "../proxy.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

// Progress checkpoints use the normal async checkpoint endpoint. The single
// StepPlanned op is what makes this the "step started" request.
function isSlowStepStartedRequest(request: RecordedRequest): boolean {
  if (
    request.method !== "POST" ||
    !/^\/v1\/checkpoint\/[^/]+\/async$/.test(request.path) ||
    !isRecord(request.body)
  ) {
    return false;
  }

  const steps = request.body.steps;
  if (!Array.isArray(steps) || steps.length !== 1) {
    return false;
  }

  const step = steps[0];
  return (
    isRecord(step) &&
    step.op === StepOpCode.StepPlanned &&
    step.displayName === "slow-step"
  );
}

test("step takes >1 second", async () => {
  // When a step takes >1 second, the SDK sends a request to tell Dev Server
  // that the step started. We'll do that by placing a proxy between this test
  // and the Dev Server.

  const proxy = createRecordingDevServerProxy();
  await proxy.start();
  onTestFinished(() => proxy.stop());

  const state = createState({ stepRunCount: 0 });
  const client = new Inngest({
    baseUrl: proxy.url,
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ runId, step }) => {
      state.runId = runId;
      return await step.run("slow-step", async () => {
        state.stepRunCount++;

        // Cross the SDK's 1s in-progress threshold.
        await sleep(1500);

        return "done";
      });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();
  expect(result).toBe("done");
  expect(state.stepRunCount).toBe(1);

  const progressRequest = proxy.requests.find(isSlowStepStartedRequest);
  if (!progressRequest) {
    throw new Error("Step started checkpoint request not sent yet");
  }

  const runId = await state.waitForRunId();
  expect(progressRequest.body).toEqual({
    fn_id: expect.any(String),
    qi_id: expect.any(String),
    run_id: runId,
    steps: [
      {
        displayName: "slow-step",
        id: "bb209016db1e6468df06a4e7204e39b7b77b01f3",
        name: "slow-step",
        op: StepOpCode.StepPlanned,
        opts: {},
        timing: {
          a: expect.any(Number),
          b: 0,
        },
        userland: {
          id: "slow-step",
        },
      },
    ],
    ts: expect.any(Number),
  });
});

test("step takes <1 second", async () => {
  // When a step takes <1 second, the SDK does not send a request to tell Dev
  // Server that the step started. We'll do that by placing a proxy between this
  // test and the Dev Server.

  const proxy = createRecordingDevServerProxy();
  await proxy.start();
  onTestFinished(() => proxy.stop());

  const state = createState({ stepRunCount: 0 });
  const client = new Inngest({
    baseUrl: proxy.url,
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ runId, step }) => {
      state.runId = runId;
      return await step.run("slow-step", async () => {
        state.stepRunCount++;

        // Don't cross the SDK's 1s in-progress threshold.
        await sleep(500);

        return "done";
      });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  const result = await state.waitForRunComplete();
  expect(result).toBe("done");
  expect(state.stepRunCount).toBe(1);

  // Wait a little longer just to ensure the "step started" request never sent.
  await sleep(1000);

  const progressRequest = proxy.requests.find(isSlowStepStartedRequest);
  expect(progressRequest).toBeUndefined();
});
