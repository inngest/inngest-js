import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../helpers";

checkIntrospection({
  name: "unhandled-step-errors",
  triggers: [{ event: "demo/unhandled.step.errors" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/unhandled.step.errors");
  });

  test("runs in response to 'demo/unhandled.step.errors'", async () => {
    runId = await eventRunWithName(eventId, "unhandled-step-errors");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  test(`ran "a fails" step and it failed, twice`, async () => {
    const item = await runHasTimeline(runId, {
      attempts: 1,
      stepType: "RUN",
      status: "FAILED",
      name: "a fails",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({
      error: {
        name: "Error",
        message: "A failed!",
        stack: expect.any(String),
        cause: null,
      },
    });
  }, 10000);

  test("function failed", async () => {
    const item = await runHasTimeline(runId, {
      stepType: "FINALIZATION",
      status: "FAILED",
    });
    expect(item).toBeDefined();
  }, 10000);

  test(`never ran "b never runs" step`, async () => {
    const item = await runHasTimeline(
      runId,
      {
        stepType: "RUN",
        name: "b never runs",
      },
      1,
    );
    expect(item).toBeUndefined();
  }, 10000);
});
