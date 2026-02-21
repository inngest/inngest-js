import { inngest } from "./client";

export default inngest.createFunction(
  { id: "hello-world", triggers: [{ event: "demo/event.sent" }] },
  async ({ event }) => {
    return {
      message: `Hello ${event.name}!`,
    };
  }
);
