import { inngest } from "../client";

export default inngest.createFunction(
  { id: "send-event" },
  { event: "demo/send.event" },
  async ({ step }) => {
    await Promise.all([
      // Send a single event
      step.sendEvent("single-event", {
        name: "app/my.event.happened",
        data: { foo: "bar" },
      }),

      // Send multiple events
      step.sendEvent("multiple-events", [
        {
          name: "app/my.event.happened.multiple.1",
          data: { foo: "bar" },
        },
        {
          name: "app/my.event.happened.multiple.2",
          data: { foo: "bar" },
        },
      ]),
    ]);
  },
);
