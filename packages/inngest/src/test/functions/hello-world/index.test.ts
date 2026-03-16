import { createState } from "@inngest/test-harness";
import { checkIntrospection, eventRunWithName, sendEvent } from "../../helpers";

checkIntrospection({
  name: "hello-world",
  triggers: [{ event: "demo/hello.world" }],
});

describe("run", () => {
  let eventId: string;
  const state = createState({});

  beforeAll(async () => {
    eventId = await sendEvent("demo/hello.world");
  });

  test("runs in response to 'demo/hello.world'", async () => {
    state.runId = await eventRunWithName(eventId, "hello-world");
    expect(state.runId).toEqual(expect.any(String));
  }, 60000);

  test("returns 'Hello, Inngest!'", async () => {
    const output = await state.waitForRunComplete();
    expect(output).toEqual("Hello, Inngest!");
  }, 60000);
});
