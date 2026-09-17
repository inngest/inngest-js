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

// Builds a matcher for an async checkpoint request carrying a "slow-step" op of
// the given op code. Both the leading-edge "step started" (StepPlanned) and
// trailing StepRun requests hit the same async checkpoint endpoint and differ
// only in the op code carried for the slow step.
function matchesSlowStepCheckpoint(
  op: StepOpCode,
): (request: RecordedRequest) => boolean {
  return (request) => {
    if (
      request.method !== "POST" ||
      !/^\/v1\/checkpoint\/[^/]+\/async$/.test(request.path) ||
      !isRecord(request.body)
    ) {
      return false;
    }

    const steps = request.body.steps;
    if (!Array.isArray(steps)) {
      return false;
    }

    return steps.some(
      (step) =>
        isRecord(step) && step.op === op && step.displayName === "slow-step",
    );
  };
}

// Progress checkpoints use the normal async checkpoint endpoint. The
// StepPlanned op is what makes this the "step started" request.
const isSlowStepStartedRequest = matchesSlowStepCheckpoint(
  StepOpCode.StepPlanned,
);

// The trailing-edge request: a normal async checkpoint carrying the
// completed StepRun for the slow step.
const isSlowStepRunRequest = matchesSlowStepCheckpoint(StepOpCode.StepRun);

function getStepTiming(request: RecordedRequest): { a: number; b: number } {
  const steps = (request.body as { steps: unknown[] }).steps;
  const step = steps.find(
    (s) => isRecord(s) && s.displayName === "slow-step",
  ) as { timing: { a: number; b: number } };
  return step.timing;
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
    request_id: expect.any(String),
    request_started_at: expect.any(Number),
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

  // The trailing StepRun is a completely normal full span. The leading
  // StepPlanned starts exactly 1ms (1e6 ns) earlier — the merge tiebreak
  // that guarantees the StepRun's attributes win server-side. Epoch-ns
  // values exceed Number.MAX_SAFE_INTEGER (~256ns float error each), so
  // allow a tolerance far below the 1ms offset.
  const runRequest = await waitFor(() => {
    const found = proxy.requests.find(isSlowStepRunRequest);
    if (!found) {
      throw new Error("Trailing StepRun checkpoint request not found");
    }
    return found;
  });
  const plannedTiming = getStepTiming(progressRequest);
  const runTiming = getStepTiming(runRequest);
  expect(Math.abs(runTiming.a - plannedTiming.a - 1_000_000)).toBeLessThan(
    10_000,
  );
  expect(runTiming.b).toBeGreaterThan(0);
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
