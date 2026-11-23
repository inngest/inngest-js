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

it.each([
  { mode: "parallel", idStyle: "string" },
  { mode: "parallel", idStyle: "object" },
  { mode: "parallel", idStyle: "mixed" },
  { mode: "sequential", idStyle: "string" },
] as const)(
  "returns duplicate step ID warnings for $mode calls with $idStyle IDs",
  async ({ mode, idStyle }) => {
    const inngest = new Inngest({ id: "test-app", logger: silentLogger });
    const fn = inngest.createFunction(
      {
        id: `duplicate-step-ids-${mode}-${idStyle}`,
        triggers: [{ event: "test/event" }],
      },
      async ({ step }) => {
        const firstId = idStyle === "string" ? "op" : { id: "op" };
        const secondId = idStyle === "object" ? { id: "op" } : "op";
        const [first, second] =
          mode === "parallel"
            ? await Promise.all([
                step.run(firstId, () => "first"),
                step.run(secondId, () => "second"),
              ])
            : [
                await step.run(firstId, () => "first"),
                await step.run(secondId, () => "second"),
              ];
        return { first, second };
      },
    );

    const engine = new InngestTestEngine({ function: fn });
    const firstRun = await engine.execute({ transformCtx: (ctx) => ctx });
    const secondRun = await engine.execute({ transformCtx: (ctx) => ctx });

    expect(firstRun.result).toEqual({ first: "first", second: "second" });
    expect(firstRun.warnings).toContainEqual(
      expect.objectContaining({ code: "AUTOMATIC_PARALLEL_INDEXING" }),
    );
    expect(secondRun.warnings).toContainEqual(
      expect.objectContaining({ code: "AUTOMATIC_PARALLEL_INDEXING" }),
    );
    expect(secondRun.warnings).not.toBe(firstRun.warnings);
  },
);

it("returns no warnings for distinct step IDs", async () => {
  const inngest = new Inngest({ id: "test-app", logger: silentLogger });
  const fn = inngest.createFunction(
    { id: "distinct-step-ids", triggers: [{ event: "test/event" }] },
    async ({ step }) => {
      const first = await step.run("first", () => "a");
      const second = await step.run("second", () => "b");
      return { first, second };
    },
  );

  const output = await new InngestTestEngine({ function: fn }).execute();

  expect(output.result).toEqual({ first: "a", second: "b" });
  expect(output.warnings).toEqual([]);
});
