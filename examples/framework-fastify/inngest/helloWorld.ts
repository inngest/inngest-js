import { inngest } from "./client";

export default inngest.createFunction(
  { name: "Hello World" },
  { event: "demo/event.sent" },
  async ({ event, step }) => {
    return {
      message: `Hello ${event.name}!`,
    };
  }
);
