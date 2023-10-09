/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "@local/test/helpers";

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
      const step = await runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: `Get ${team} team score`,
      });

      expect(step).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      expect(step.output).toEqual(expect.any(String));
    }, 60000);
  });

  test("Returned total score", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        output: JSON.stringify("150"),
      })
    ).resolves.toBeDefined();
  }, 60000);
});
