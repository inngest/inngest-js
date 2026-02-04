import { inngest } from "./client";

export default inngest.createFunction(
  { id: "hello-world", triggers: [{ event: "demo/event.sent" }] },
  async ({ event, step }) => {
    // A random call that will trigger automatic Node instrumentation and create
    // a span
    await fetch("http://localhost:3000/api/inngest");

    return {
      message: `Hello ${event.name}!`,
    };
  }
);
