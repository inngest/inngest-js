import {
  createState,
  createTestApp,
  getStepsWithStatus,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, onTestFinished, test } from "vitest";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import { Gate } from "../durableEndpoints/helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);
const stepID = "slow-step";

test("step takes >1 second", async () => {
  // When a step takes >1 second, we send a "step started" request that marks
  // the step as running. This allows users to see their long-running step IDs
  // in the UI. Without this, long-running step IDs don't appear until after the
  // step ends.

  const state = createState({ stepDone: false, stepRunCount: 0 });
  const gate = new Gate();

  const client = new Inngest({
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
      return await step.run(stepID, async () => {
        state.stepRunCount++;

        // Cross the SDK's 1s in-progress threshold, then pause so the test can
        // inspect the trace before the step completes.
        await sleep(1500);

        // Use a gate to ensure we can assert the "running" state of the step.
        await gate.wait();

        state.stepDone = true;
        return "done";
      });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });
  onTestFinished(() => gate.open());

  await client.send({ name: eventName });
  const runId = await state.waitForRunId();
  await gate.waitUntilReached();

  await waitFor(async () => {
    expect(await getStepsWithStatus({ runId, status: "RUNNING" })).includes(
      stepID,
    );
  });

  gate.open();
  const result = await state.waitForRunComplete();
  expect(result).toBe("done");
  expect(state.stepRunCount).toBe(1);
  expect(await getStepsWithStatus({ runId, status: "COMPLETED" })).includes(
    stepID,
  );
});
