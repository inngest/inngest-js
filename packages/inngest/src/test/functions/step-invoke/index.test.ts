import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../helpers";

checkIntrospection({
  name: "step-invoke",
  triggers: [{ event: "demo/step.invoke" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/step.invoke");
  });

  test("runs in response to 'demo/step.invoke'", async () => {
    runId = await eventRunWithName(eventId, "step-invoke");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  test("ran 'event-fn' step", async () => {
    const item = await runHasTimeline(runId, {
      stepType: "StepCompleted",
      name: "event-fn",
    });
    expect(item).toBeDefined();

    // TODO We don't return the result in history yet
    // const output = await item?.getOutput();
    // expect(output).toEqual({ data: { eventInvokeDone: true } });
  }, 60000);

  test("ran 'cron-fn' step", async () => {
    const item = await runHasTimeline(runId, {
      stepType: "StepCompleted",
      name: "cron-fn",
    });
    expect(item).toBeDefined();

    // TODO We don't return the result in history yet
    // const output = await item?.getOutput();
    // expect(output).toEqual({ data: { cronInvokeDone: true } });
  }, 60000);

  test("returns array of both results", async () => {
    const item = await runHasTimeline(runId, {
      stepType: "FunctionCompleted",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual([
      { eventInvokeDone: true },
      { cronInvokeDone: true },
    ]);
  }, 60000);
});
