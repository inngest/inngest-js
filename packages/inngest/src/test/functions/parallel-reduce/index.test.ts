import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../helpers";

checkIntrospection({
  name: "parallel-reduce",
  triggers: [{ event: "demo/parallel.reduce" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/parallel.reduce");
  });

  test("runs in response to 'demo/parallel.reduce'", async () => {
    runId = await eventRunWithName(eventId, "parallel-reduce");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  ["blue", "red", "green"].forEach((team) => {
    test(`ran "Get ${team} team score" step`, async () => {
      const item = await runHasTimeline(runId, {
        type: "StepCompleted",
        stepName: `Get ${team} team score`,
      });
      expect(item).toBeDefined();

      const output = await item?.getOutput();
      expect(output).toEqual({ data: expect.any(Number) });
    }, 60000);
  });

  test("Returned total score", async () => {
    const item = await runHasTimeline(runId, {
      type: "FunctionCompleted",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual(150);
  }, 60000);
});
