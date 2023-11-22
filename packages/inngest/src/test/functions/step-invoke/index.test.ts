/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "@local/test/helpers";

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
    const step = await runHasTimeline(runId, {
      __typename: "StepEvent",
      stepType: "COMPLETED",
      name: "event-fn",
      output: JSON.stringify({ data: { eventInvokeDone: true } }),
    });

    expect(step).toBeDefined();
  }, 60000);

  test("ran 'cron-fn' step", async () => {
    const step = await runHasTimeline(runId, {
      __typename: "StepEvent",
      stepType: "COMPLETED",
      name: "cron-fn",
      output: JSON.stringify({ data: { cronInvokeDone: true } }),
    });

    expect(step).toBeDefined();
  }, 60000);

  test("returns array of both results", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        output: JSON.stringify([
          { eventInvokeDone: true },
          { cronInvokeDone: true },
        ]),
      })
    ).resolves.toBeDefined();
  }, 60000);
});
