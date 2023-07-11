/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "@local/test/helpers";

checkIntrospection({
  name: "Promise.race",
  triggers: [{ event: "demo/promise.race" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/promise.race");
  });

  test("runs in response to 'demo/promise.race'", async () => {
    runId = await eventRunWithName(eventId, "Promise.race");
    expect(runId).toEqual(expect.any(String));
  });

  test("ran Step A", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "Step A",
        output: '"A"',
      })
    ).resolves.toBeDefined();
  });

  test("ran Step B", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "Step B",
        output: '"B"',
      })
    ).resolves.toBeDefined();
  });

  let winner: "A" | "B" | undefined;

  test("ran Step C", async () => {
    const timelineItem = await runHasTimeline(runId, {
      __typename: "StepEvent",
      stepType: "COMPLETED",
      name: "Step C",
    });

    expect(timelineItem).toBeDefined();
    const output = JSON.parse(timelineItem.output);
    winner =
      output === "A is the winner!"
        ? "A"
        : output === "B is the winner!"
        ? "B"
        : undefined;
    expect(["A", "B"]).toContain(winner);
  });
});
