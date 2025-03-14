import { inngest } from "./client";

export default inngest.createFunction(
  { id: "hello-world" },
  { event: "demo/event.sent" },
  async ({ event, step }) => {
    await fetch("http://localhost:3000/api/inngest");

    return {
      message: `Hello ${event.name}!`,
    };
  }
);
