import { ConsoleLogger, Inngest } from "inngest";
import { spies } from "tinyspy";
import { expect, it } from "vitest";
import { InngestTestEngine } from "./index";
import { fn, mockAny } from "./spy";

it("should not register spies created with fn() in tinyspy's registry", () => {
  const before = spies.size;

  const spy = fn((a: number) => a + 1);
  mockAny({ a: () => 1, b: { c: () => 2 } });

  expect(spy(1)).toBe(2);
  expect(spy.mock.calls).toEqual([[1]]);
  expect(spies.size).toBe(before);
});

it("should not accumulate spies across executions", async () => {
  const inngest = new Inngest({
    id: "test-app",
    logger: new ConsoleLogger({ level: "silent" }),
  });
  const fn = inngest.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      await step.run("one", () => 1);
      await step.run("two", () => 2);
      return "done";
    },
  );

  const before = spies.size;
  const t = new InngestTestEngine({ function: fn });
  for (let i = 0; i < 5; i++) {
    const output = await t.execute();
    expect(output.result).toBe("done");
  }

  expect(spies.size).toBe(before);
});
