import {
  checkIntrospection,
  eventRunWithName,
  runHasTimeline,
  sendEvent,
} from "../../helpers";

checkIntrospection({
  name: "hello-world",
  triggers: [{ event: "demo/hello.world" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/hello.world");
  });

  test("runs in response to 'demo/hello.world'", async () => {
    runId = await eventRunWithName(eventId, "hello-world");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  test("returns 'Hello, Inngest!'", async () => {
    const item = await runHasTimeline(runId, {
      stepType: "StepCompleted",
      name: "step",
    });

    expect(item).toBeDefined();

    const output = await item?.getOutput();
    expect(output).toEqual("Hello, Inngest!");
  }, 60000);
});
