import { Inngest } from "inngest";
import { expect, it } from "vitest";
import { InngestTestEngine } from "./index";

it("should merge options from the original engine", async () => {
  const inngest = new Inngest({ id: "test-app" });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      const a = await step.run("step-a", () => "unmocked");
      return a;
    },
  );

  const t = new InngestTestEngine({ function: fn });
  const cloned = t.clone({
    steps: [{ id: "step-a", handler: () => "from-clone" }],
  });
  const output = await cloned.execute();
  expect(output.result).toBe("from-clone");
});

it("should share mock handler cache across clones", async () => {
  const inngest = new Inngest({ id: "test-app" });
  let callCount = 0;

  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      const a = await step.run("step-a", () => "unmocked");
      return a;
    },
  );

  const t = new InngestTestEngine({
    function: fn,
    steps: [
      {
        id: "step-a",
        handler: () => {
          callCount++;
          return "mocked";
        },
      },
    ],
  });
  const cloned = t.clone();
  await t.execute();
  await cloned.execute();

  // Handler should only run once despite two executions, because the
  // cache is shared between the original and cloned engine
  expect(callCount).toBe(1);
});
