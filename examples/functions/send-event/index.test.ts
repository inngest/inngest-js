/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  checkIntrospection,
  eventRunWithName,
  receivedEventWithName,
  runHasTimeline,
  sendEvent,
} from "@local/test/helpers";

checkIntrospection({
  name: "Send event",
  triggers: [{ event: "demo/send.event" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/send.event");
  });

  test("runs in response to 'demo/send.event'", async () => {
    runId = await eventRunWithName(eventId, "Send event");
    expect(runId).toEqual(expect.any(String));
  });

  test("ran Step 'sendEvent'", async () => {
    await expect(
      runHasTimeline(runId, {
        __typename: "StepEvent",
        stepType: "COMPLETED",
        name: "sendEvent",
      })
    ).resolves.toBeDefined();
  });

  test("sent event 'app/my.event.happened'", async () => {
    const event = await receivedEventWithName("app/my.event.happened");
    expect(event).toBeDefined();
    expect(JSON.parse(event?.payload ?? {})).toMatchObject({ foo: "bar" });
  });

  test("sent event 'app/my.event.happened.multiple.1'", async () => {
    const event = await receivedEventWithName(
      "app/my.event.happened.multiple.1"
    );
    expect(event).toBeDefined();
    expect(JSON.parse(event?.payload ?? {})).toMatchObject({ foo: "bar" });
  });

  test("sent event 'app/my.event.happened.multiple.2'", async () => {
    const event = await receivedEventWithName(
      "app/my.event.happened.multiple.2"
    );
    expect(event).toBeDefined();
    expect(JSON.parse(event?.payload ?? {})).toMatchObject({ foo: "bar" });
  });
});
