import { inngest } from "../client";

export const events = ["demo/multiple-triggers.1", "demo/multiple-triggers.2"];

export default inngest.createFunction(
  { id: "multiple-triggers" },
  events.map((event) => ({ event })),
  ({ event }) => `Hello, ${event.name}!`,
);
