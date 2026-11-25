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

it("should run a parallel step that is found after a non-runnable step", async () => {
  const inngest = new Inngest({ id: "test-app" });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      const [, work] = await Promise.all([
        step.sleep("nap", "1h"),
        step.run("work", () => "worked"),
      ]);
      return work;
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const output = await t.executeStep("work");
  expect(output.result).toBe("worked");
});

it("should run each parallel step once when the target step is not first", async () => {
  const inngest = new Inngest({ id: "test-app" });
  const calls: string[] = [];
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      const [a, b] = await Promise.all([
        step.run("parallel-a", () => {
          calls.push("parallel-a");
          return "a";
        }),
        step.run("parallel-b", () => {
          calls.push("parallel-b");
          return "b";
        }),
      ]);
      return `${a}-${b}`;
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const output = await t.executeStep("parallel-b");
  expect(output.result).toBe("b");
  expect(calls.filter((id) => id === "parallel-a")).toHaveLength(1);
  expect(calls.filter((id) => id === "parallel-b")).toHaveLength(1);
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
