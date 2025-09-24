import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../helpers";

const events = ["demo/multiple-triggers.1", "demo/multiple-triggers.2"];

checkIntrospection({
  name: "multiple-triggers",
  triggers: events.map((event) => ({ event })),
});

describe("run", () => {
  events.forEach((eventName) => {
    let eventId: string;
    let runId: string;

    beforeAll(async () => {
      eventId = await sendEvent(eventName);
    });

    test(`runs in response to '${eventName}'`, async () => {
      runId = await eventRunWithName(eventId, "multiple-triggers");
      expect(runId).toEqual(expect.any(String));
    }, 60000);

    test(`returns 'Hello, ${eventName}!'`, async () => {
      const item = await runHasTimeline(runId, {
        type: "StepCompleted",
        stepName: "step",
      });

      expect(item).toBeDefined();

      const output = await item?.getOutput();
      expect(output).toEqual(`Hello, ${eventName}!`);
    }, 60000);
  });
});
