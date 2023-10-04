/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "@local/test/helpers";

checkIntrospection({
  name: "undefined-data",
  triggers: [{ event: "demo/undefined.data" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/undefined.data");
  });

  test("runs in response to 'demo/undefined.data'", async () => {
    runId = await eventRunWithName(eventId, "undefined-data");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  test("ran step1", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "step1",
        output: JSON.stringify({ data: null }),
      })
    ).resolves.toBeDefined();
  }, 60000);

  test("ran step2res", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "step2res",
        output: JSON.stringify({ data: "step2res" }),
      })
    ).resolves.toBeDefined();
  }, 60000);

  test("ran step2nores", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "step2nores",
        output: JSON.stringify({ data: null }),
      })
    ).resolves.toBeDefined();
  }, 60000);

  test("ran step2res2", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "step2res2",
        output: JSON.stringify({ data: "step2res2" }),
      })
    ).resolves.toBeDefined();
  }, 60000);

  test("ran step2", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "step2",
        output: JSON.stringify({ data: null }),
      })
    ).resolves.toBeDefined();
  }, 60000);

  test("ran step3", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "step3",
        output: JSON.stringify({ data: null }),
      })
    ).resolves.toBeDefined();
  }, 60000);
});
