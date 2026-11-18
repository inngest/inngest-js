import { Inngest } from "inngest";
import { describe, expect, it } from "vitest";
import { InngestTestEngine } from "./index";

describe("InngestTestEngine step.sendEvent", () => {
  it("mocks step.sendEvent instead of calling the Inngest API", async () => {
    const inngest = new Inngest({ id: "test-app" });

    let called = false;
    const fn = inngest.createFunction(
      { id: "send-event-fn", triggers: [{ event: "test/event" }] },
      async ({ step }) => {
        await step.sendEvent("my-event", {
          name: "my-event",
          data: { hello: "world" },
        });
        called = true;
        return "done";
      },
    );

    const t = new InngestTestEngine({ function: fn });
    const result = await t.execute({ events: [{ name: "test/event" }] });

    expect(result.error).toBeUndefined();
    expect(called).toBe(true);
    expect(result.result).toBe("done");
  });
});
