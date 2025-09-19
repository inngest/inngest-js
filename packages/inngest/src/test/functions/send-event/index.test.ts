import {
  checkIntrospection,
  eventRunWithName,
  receivedEventWithName,
  sendEvent,
} from "../../helpers";

checkIntrospection({
  name: "send-event",
  triggers: [{ event: "demo/send.event" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/send.event");
  });

  test("runs in response to 'demo/send.event'", async () => {
    runId = await eventRunWithName(eventId, "send-event");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  test("sent event 'app/my.event.happened'", async () => {
    const event = await receivedEventWithName("app/my.event.happened");
    expect(event).toBeDefined();
    expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({ foo: "bar" });
  }, 60000);

  test("sent event 'app/my.event.happened.multiple.1'", async () => {
    const event = await receivedEventWithName(
      "app/my.event.happened.multiple.1",
    );
    expect(event).toBeDefined();
    expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({ foo: "bar" });
  }, 60000);

  test("sent event 'app/my.event.happened.multiple.2'", async () => {
    const event = await receivedEventWithName(
      "app/my.event.happened.multiple.2",
    );
    expect(event).toBeDefined();
    expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({ foo: "bar" });
  }, 60000);
});
