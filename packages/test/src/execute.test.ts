import { ConsoleLogger, Inngest } from "inngest";
import { expect, it } from "vitest";
import { InngestTestEngine } from "./index";

const silentLogger = new ConsoleLogger({ level: "silent" });

it("should return error when the function throws", async () => {
  const inngest = new Inngest({ id: "test-app", logger: silentLogger });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async () => {
      throw new Error("function exploded");
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const output = await t.execute();
  expect(output.error).toBeDefined();
  expect(output.result).toBeUndefined();
});

it("should return error when a step throws during execute", async () => {
  const inngest = new Inngest({ id: "test-app", logger: silentLogger });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      await step.run("bad-step", () => {
        throw new Error("step exploded");
      });
      return "unreachable";
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const output = await t.execute();
  expect(output.error).toBeDefined();
  expect(output.result).toBeUndefined();
});

it("should return ctx with mocked step tools", async () => {
  const inngest = new Inngest({ id: "test-app" });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      const val = await step.run("my-step", () => "hello");
      return val;
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const output = await t.execute();
  expect(output.result).toBe("hello");
  expect(output.ctx).toBeDefined();
  expect(output.ctx.step).toBeDefined();

  // step tools should be mocked (have .mock property from the spy)
  expect(output.ctx.step.run).toBeDefined();
  expect((output.ctx.step.run as any).mock).toBeDefined();
});

it("should pass custom event data to the function", async () => {
  const inngest = new Inngest({ id: "test-app" });
  let receivedEvent: any;
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ event }) => {
      receivedEvent = event;
      return event.data.greeting;
    },
  );

  const t = new InngestTestEngine({
    function: fn,
    events: [
      {
        id: "evt-1",
        name: "test/event",
        data: { greeting: "hi" },
        ts: Date.now(),
      },
    ],
  });
  const output = await t.execute();
  expect(output.result).toBe("hi");
  expect(receivedEvent.data.greeting).toBe("hi");
});
