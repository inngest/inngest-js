/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "@local/test/helpers";

checkIntrospection({
  name: "hello-world",
  triggers: [{ event: "demo/hello.world" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/hello.world");
  });

  test("runs in response to 'demo/hello.world'", async () => {
    runId = await eventRunWithName(eventId, "hello-world");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  test("returns 'Hello, Inngest!'", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        output: JSON.stringify({
          body: { data: "Hello, Inngest!" },
          status: 200,
        }),
      })
    ).resolves.toBeDefined();
  }, 60000);
});
