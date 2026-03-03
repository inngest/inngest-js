import { createState } from "@inngest/test-harness";
import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../helpers";

checkIntrospection({
  name: "sequential-reduce",
  triggers: [{ event: "demo/sequential.reduce" }],
});

describe("run", () => {
  let eventId: string;
  const state = createState({});

  beforeAll(async () => {
    eventId = await sendEvent("demo/sequential.reduce");
  });

  test("runs in response to 'demo/sequential.reduce'", async () => {
    state.runId = await eventRunWithName(eventId, "sequential-reduce");
    expect(state.runId).toEqual(expect.any(String));
  }, 60000);

  ["blue", "red", "green"].forEach((team) => {
    test(`ran "Get ${team} team score" step`, async () => {
      const item = await runHasTimeline(state.runId!, {
        stepType: "RUN",
        status: "COMPLETED",
        name: `Get ${team} team score`,
      });
      expect(item).toBeDefined();

      const output = await item?.getOutput();
      expect(output).toEqual({ data: expect.any(Number) });
    }, 60000);
  });

  test("Returned total score", async () => {
    const output = await state.waitForRunComplete();
    expect(output).toEqual(150);
  }, 60000);
});
