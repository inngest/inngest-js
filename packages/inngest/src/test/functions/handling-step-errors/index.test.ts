import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../helpers";

checkIntrospection({
  name: "handling-step-errors",
  triggers: [{ event: "demo/handling.step.errors" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/handling.step.errors");
  });

  test("runs in response to 'demo/handling.step.errors'", async () => {
    runId = await eventRunWithName(eventId, "handling-step-errors");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  test(`ran "a" step and it failed, twice`, async () => {
    const item = await runHasTimeline(runId, {
      attempts: 1,
      stepType: "RUN",
      status: "FAILED",
      name: "a",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({
      error: {
        name: "Error",
        message: "Oh no!",
        stack: expect.any(String),
        cause: expect.objectContaining({
          name: "Error",
          message: "This is the cause",
        }),
      },
    });
  }, 10000);

  test(`ran "b" step`, async () => {
    const item = await runHasTimeline(runId, {
      status: "COMPLETED",
      stepType: "RUN",
      name: "b",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({
      data: `err was: "Oh no!" and the cause was: "This is the cause"`,
    });
  }, 10000);

  test(`ran "c succeeds" step`, async () => {
    const item = await runHasTimeline(runId, {
      status: "COMPLETED",
      stepType: "RUN",
      name: "c succeeds",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: "c succeeds" });
  });

  test(`ran "d fails" step and it failed, twice`, async () => {
    const item = await runHasTimeline(runId, {
      attempts: 1,
      status: "FAILED",
      stepType: "RUN",
      name: "d fails",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({
      error: {
        name: "Error",
        message: "D failed!",
        stack: expect.any(String),
        cause: null,
      },
    });
  });

  test(`ran "e succeeds" step`, async () => {
    const item = await runHasTimeline(runId, {
      status: "COMPLETED",
      stepType: "RUN",
      name: "e succeeds",
    });
    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual({ data: { errMessage: "D failed!" } });
  });
});
