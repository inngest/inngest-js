/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../test/helpers";

checkIntrospection({
  name: "Hello World",
  triggers: [{ event: "demo/hello.world" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/hello.world");
  });

  test("runs in response to 'demo/hello.world'", async () => {
    runId = await eventRunWithName(eventId, "Hello World");
    expect(runId).toEqual(expect.any(String));
  });

  test("returns 'Hello, Inngest!'", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        output: JSON.stringify({ body: "Hello, Inngest!", status: 200 }),
      })
    ).resolves.toBeDefined();
  });
});
