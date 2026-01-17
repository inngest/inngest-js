import { inngest } from "./client";

export default inngest.createFunction(
  { id: "hello-world" },
  { event: "demo/event.sent" },
  async ({ event, step }) => {
    return {
      message: `Hello ${event.name} ${Math.random()}!`,
    };
  }
);
