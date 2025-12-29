import { inngest } from "./client";
import { event } from "inngest/components/trigger";

const myEvent = event("demo/event.sent");

export default inngest.createFunction(
  { id: "hello-world" },
  { name: "demo/event.sent" },
  async ({ event, step }) => {
    return {
      message: `Hello ${event.name}!`,
    };
  }
);
