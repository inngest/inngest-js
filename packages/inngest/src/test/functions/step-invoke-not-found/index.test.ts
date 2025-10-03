import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../helpers";

checkIntrospection({
  name: "step-invoke-not-found",
  triggers: [{ event: "demo/step.invoke.not-found" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/step.invoke.not-found");
  });

  test("runs in response to 'demo/step.invoke.not-found'", async () => {
    runId = await eventRunWithName(eventId, "step-invoke-not-found");
    expect(runId).toEqual(expect.any(String));
  }, 20000);

  test("ran 'invoke-non-existent-fn' step", async () => {
    const item = await runHasTimeline(runId, {
      stepType: "StepFailed",
      name: "step",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output?.name).toEqual("Error");
    expect(output?.message).toContain("could not find function");
  }, 20000);
});
