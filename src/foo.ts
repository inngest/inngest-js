import { Inngest } from "./components/Inngest";

const inngest = new Inngest<{
  "demo/event.sent": { name: "demo/event.sent"; data: { name: string } };
}>({ name: "My App" });

inngest.createFunction("Normal", "demo/event.sent", ({ event }) => {
  return event.data.name;
});

inngest.createStepFunction("Step Fn", "demo/event.sent", function* ({ event }) {
  yield [true];

  return event.data.name;
});
