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
  name: "promise-race",
  triggers: [{ event: "demo/promise.race" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/promise.race");
  });

  test("runs in response to 'demo/promise.race'", async () => {
    runId = await eventRunWithName(eventId, "promise-race");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  test("ran Step A", async () => {
    const item = await runHasTimeline(runId, {
      type: "StepCompleted",
      stepName: "Step A",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: "A" });
  }, 60000);

  test("ran Step B", async () => {
    const item = await runHasTimeline(runId, {
      type: "StepCompleted",
      stepName: "Step B",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: "B" });
  }, 60000);

  let winner: "A" | "B" | undefined;

  test("ran Step C", async () => {
    const item = await runHasTimeline(runId, {
      type: "StepCompleted",
      stepName: "Step C",
    });

    expect(item).toBeDefined();

    const output = await item?.getOutput();
    winner =
      output.data === "A is the winner!"
        ? "A"
        : output.data === "B is the winner!"
          ? "B"
          : undefined;
    expect(["A", "B"]).toContain(winner);
  }, 60000);
});
