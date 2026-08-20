import { ConsoleLogger, Inngest } from "inngest";
import { expect, it } from "vitest";
import { InngestTestEngine } from "./index";

const silentLogger = new ConsoleLogger({ level: "silent" });

it("should wait for function-resolved checkpoint", async () => {
  const inngest = new Inngest({ id: "test-app" });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      await step.run("step-a", () => "a");
      return "done";
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const { run } = await t["individualExecution"]();
  const output = await run.waitFor("function-resolved");
  expect(output.result.type).toBe("function-resolved");
  expect(output.result.data).toBe("done");
});

it("should wait for a specific step by id using subset matching", async () => {
  const inngest = new Inngest({ id: "test-app" });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      await step.run("step-a", () => "a");
      await step.run("step-b", () => "b");
      return "done";
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const { run } = await t["individualExecution"]();
  const output = await run.waitFor("step-ran", { step: { id: "step-b" } });
  expect(output.result.type).toBe("step-ran");
  expect(output.result.step.data).toBe("b");
});

it("should wait for steps-found with subset matching on step ids", async () => {
  const inngest = new Inngest({ id: "test-app" });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      const [a, b] = await Promise.all([
        step.run("parallel-a", () => "a"),
        step.run("parallel-b", () => "b"),
      ]);
      return `${a}-${b}`;
    },
  );

  const t = new InngestTestEngine({
    function: fn,
    disableImmediateExecution: true,
  });
  const { run } = await t["individualExecution"]();
  const output = await run.waitFor("steps-found", {
    steps: [{ id: "parallel-a" }],
  });
  expect(output.result.type).toBe("steps-found");
  expect(output.result.steps.length).toBeGreaterThanOrEqual(1);
});

it("should reject when function fails while waiting for a different checkpoint", async () => {
  const inngest = new Inngest({ id: "test-app", logger: silentLogger });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async () => {
      throw new Error("boom");
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const { run } = await t["individualExecution"]();
  await expect(run.waitFor("function-resolved")).rejects.toBeDefined();
});
