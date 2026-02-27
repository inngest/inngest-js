import { createState } from "@inngest/test-harness";
import { checkIntrospection, eventRunWithName, sendEvent } from "../../helpers";

const events = ["demo/multiple-triggers.1", "demo/multiple-triggers.2"];

checkIntrospection({
  name: "multiple-triggers",
  triggers: events.map((event) => ({ event })),
});

describe("run", () => {
  events.forEach((eventName) => {
    let eventId: string;
    const state = createState({});

    beforeAll(async () => {
      eventId = await sendEvent(eventName);
    });

    test(`runs in response to '${eventName}'`, async () => {
      state.runId = await eventRunWithName(eventId, "multiple-triggers");
      expect(state.runId).toEqual(expect.any(String));
    }, 60000);

    test(`returns 'Hello, ${eventName}!'`, async () => {
      const output = await state.waitForRunComplete();
      expect(output).toEqual(`Hello, ${eventName}!`);
    }, 60000);
  });
});
