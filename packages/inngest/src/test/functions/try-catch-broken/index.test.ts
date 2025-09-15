import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "@local/test/helpers";

checkIntrospection({
  name: "try-catch-broken",
  triggers: [{ event: "demo/try.catch.broken" }],
});

describe("try/catch with StepFailed", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/try.catch.broken");
  });

  test("runs in response to 'demo/try.catch.broken'", async () => {
    runId = await eventRunWithName(eventId, "try-catch-broken");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  test("step fails with StepFailed opcode", async () => {
    const item = await runHasTimeline(runId, {
      type: "StepFailed",
      stepName: "failing-step",
    });
    expect(item).toBeDefined();
  }, 10000);

  test("function should complete successfully with try/catch result", async () => {
    const item = await runHasTimeline(runId, {
      type: "FunctionCompleted",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({
      data: "Gracefully handled error!",
    });
  }, 10000);
});
