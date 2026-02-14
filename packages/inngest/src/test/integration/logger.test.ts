import { expect, test, vi } from "vitest";
import { Inngest } from "../../index.ts";
import { createTestApp } from "../devServerTestHarness.ts";
import { createState, randomSuffix, testNameFromFileUrl } from "./utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

type Logger = {
  info: (...args: unknown[]) => unknown;
  warn: (...args: unknown[]) => unknown;
  error: (...args: unknown[]) => unknown;
  debug: (...args: unknown[]) => unknown;
  flush: () => void;
};

function createLogger(logger: Partial<Logger>): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
    ...logger,
  } as const;
}

for (const checkpointing of [true, false]) {
  describe(`checkpointing: ${checkpointing}`, () => {
    test("flushes with no steps", async () => {
      const state = createState({ sequence: [] as string[] });
      const logger = createLogger({
        flush: () => {
          state.sequence.push("flush");
        },
      });

      const eventName = randomSuffix("evt");
      const client = new Inngest({
        checkpointing,
        id: randomSuffix(testFileName),
        isDev: true,
        logger,
      });
      const fn = client.createFunction(
        { id: "fn", retries: 0, triggers: [{ event: eventName }] },
        async ({ runId }) => {
          state.sequence.push("fn");
          state.runId = runId;
          return "done";
        },
      );
      await createTestApp({ client, functions: [fn] });

      await client.send({ name: eventName });
      await state.waitForRunComplete();
      expect(state.sequence).toEqual(["fn", "flush"]);
    });

    test("flushes with 2 steps", async () => {
      const state = createState({ sequence: [] as string[] });
      const logger = createLogger({
        flush: () => {
          state.sequence.push("flush");
        },
      });

      const eventName = randomSuffix("evt");
      const client = new Inngest({
        checkpointing,
        id: randomSuffix(testFileName),
        isDev: true,
        logger,
      });
      const fn = client.createFunction(
        { id: "fn", retries: 0, triggers: [{ event: eventName }] },
        async ({ step, runId }) => {
          state.runId = runId;
          state.sequence.push("fn");
          await step.run("step-a", () => "a");
          await step.run("step-b", () => "b");
          await step.sleep("zzz", "1s");
          return "done";
        },
      );
      await createTestApp({ client, functions: [fn] });

      await client.send({ name: eventName });
      await state.waitForRunComplete();

      if (checkpointing) {
        expect(state.sequence).toEqual(["fn", "flush", "fn", "flush"]);
      } else {
        expect(state.sequence).toEqual([
          "fn",
          "flush",
          "fn",
          "flush",
          "fn",
          "flush",
          "fn",
          "flush",
        ]);
      }
    });

    test("flushes when function throws", async () => {
      const state = createState({ sequence: [] as string[] });
      const logger = createLogger({
        flush: () => {
          state.sequence.push("flush");
        },
      });

      const eventName = randomSuffix("evt");
      const client = new Inngest({
        checkpointing,
        id: randomSuffix(testFileName),
        isDev: true,
        logger,
      });
      const fn = client.createFunction(
        { id: "fn", retries: 0, triggers: [{ event: eventName }] },
        async ({ runId }) => {
          state.sequence.push("fn");
          state.runId = runId;
          throw new Error("boom");
        },
      );
      await createTestApp({ client, functions: [fn] });

      await client.send({ name: eventName });
      await state.waitForRunFailed();
      expect(state.sequence).toEqual(["fn", "flush"]);
    });
  });
}
