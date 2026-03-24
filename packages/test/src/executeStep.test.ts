import { ConsoleLogger, Inngest } from "inngest";
import { expect, it } from "vitest";
import { InngestTestEngine } from "./index";

const silentLogger = new ConsoleLogger({ level: "silent" });

it("should run a specific step and return its result", async () => {
  const inngest = new Inngest({ id: "test-app" });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      const a = await step.run("step-a", () => "result-a");
      const b = await step.run("step-b", () => `result-b-from-${a}`);
      return b;
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const output = await t.executeStep("step-a");
  expect(output.result).toBe("result-a");
  expect(output.step).toBeDefined();
});

it("should return result for a step that depends on a mocked prior step", async () => {
  const inngest = new Inngest({ id: "test-app" });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      const a = await step.run("step-a", () => "unmocked-a");
      const b = await step.run("step-b", () => `from-${a}`);
      return b;
    },
  );

  const t = new InngestTestEngine({
    function: fn,
    steps: [{ id: "step-a", handler: () => "mocked-a" }],
  });
  const output = await t.executeStep("step-b");
  expect(output.result).toBe("from-mocked-a");
});

it("should return sleep step without executing it", async () => {
  const inngest = new Inngest({ id: "test-app" });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      await step.sleep("wait", "1d");
      await step.run("after-sleep", () => "done");
      return "finished";
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const output = await t.executeStep("wait");

  // Sleep steps are non-runnable. They return immediately with the step info
  expect(output.step).toBeDefined();
  expect(output.result).toBeUndefined();
});

it("should return waitForEvent step without executing it", async () => {
  const inngest = new Inngest({ id: "test-app" });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      const event = await step.waitForEvent("wait-for-approval", {
        event: "app/approved",
        timeout: "1h",
      });
      return event;
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const output = await t.executeStep("wait-for-approval");
  expect(output.step).toBeDefined();
  expect(output.result).toBeUndefined();
});

it("should return error when a step throws", async () => {
  const inngest = new Inngest({ id: "test-app", logger: silentLogger });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      await step.run("failing-step", () => {
        throw new Error("step failed");
      });
      return "should not reach";
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const output = await t.executeStep("failing-step");
  expect(output.error).toBeDefined();
});
