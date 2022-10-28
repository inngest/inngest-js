import { Inngest } from "./components/Inngest";

const inngest = new Inngest<{
  "demo/event.sent": { name: "demo/event.sent"; data: { name: string } };
}>({ name: "My App" });

inngest.createFunction("Normal", "demo/event.sent", ({ event }) => {
  return event.data.name;
});

const foo = function* (event: string) {
  yield "bar";
  return "bar";
};

inngest.createStepFunction(
  "Something",
  "demo/event.sent",
  function* ({ event, tools: { waitForEvent } }) {
    const anotherEvent = yield* waitForEvent("demo/another.event.sent");
    return event.data.name + " and " + anotherEvent.data.name;
  }
);

inngest.createStepFunction(
  "Step Fn",
  "demo/event.sent",
  function* ({ event, tools: { waitForEvent } }) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const anotherEvent = yield* foo("wow");
    // return anotherEvent.data.name;
  }
);

// const bar = function* () {
//   const baz = yield* foo("demo/event.sent");
// };
