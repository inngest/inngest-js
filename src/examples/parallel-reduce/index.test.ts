/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent
} from "../../test/helpers";

checkIntrospection({
  name: "Parallel Reduce",
  triggers: [{ event: "demo/parallel.reduce" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/parallel.reduce");
  });

  test("runs in response to 'demo/parallel.reduce'", async () => {
    runId = await eventRunWithName(eventId, "Parallel Reduce");
    expect(runId).toEqual(expect.any(String));
  });

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
    });
  });

  test("Returned total score", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        output: JSON.stringify({ body: "150", status: 200 }),
      })
    ).resolves.toBeDefined();
  });
});
