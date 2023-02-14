import { inngest } from "../client";

export default inngest.createFunction(
  { name: "Send event" },
  "demo/send.event",
  async ({ step }) => {
    await step.sendEvent("app/my.event.happened", { data: { foo: "bar" } });
  }
);
