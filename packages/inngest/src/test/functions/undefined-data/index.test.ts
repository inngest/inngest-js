import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../helpers";

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
    const item = await runHasTimeline(runId, {
      type: "StepCompleted",
      stepName: "step1",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: null });
  }, 60000);

  test("ran step2res", async () => {
    const item = await runHasTimeline(runId, {
      type: "StepCompleted",
      stepName: "step2res",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: "step2res" });
  }, 60000);

  test("ran step2nores", async () => {
    const item = await runHasTimeline(runId, {
      type: "StepCompleted",
      stepName: "step2nores",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: null });
  }, 60000);

  test("ran step2res2", async () => {
    const item = await runHasTimeline(runId, {
      type: "StepCompleted",
      stepName: "step2res2",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: "step2res2" });
  }, 60000);

  test("ran step2", async () => {
    const item = await runHasTimeline(runId, {
      type: "StepCompleted",
      stepName: "step2",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: null });
  }, 60000);

  test("ran step3", async () => {
    const item = await runHasTimeline(runId, {
      type: "StepCompleted",
      stepName: "step3",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: null });
  }, 60000);
});
