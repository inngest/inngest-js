/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "@local/test/helpers";

checkIntrospection({
  name: "Promise.all",
  triggers: [{ event: "demo/promise.all" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/promise.all");
  });

  test("runs in response to 'demo/promise.all'", async () => {
    runId = await eventRunWithName(eventId, "Promise.all");
    expect(runId).toEqual(expect.any(String));
  });

  test("ran Step 1", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "Step 1",
        output: "1",
      })
    ).resolves.toBeDefined();
  });

  test("ran Step 2", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "Step 2",
        output: "2",
      })
    ).resolves.toBeDefined();
  });

  test("ran Step 3", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "Step 3",
        output: "3",
      })
    ).resolves.toBeDefined();
  });
});
