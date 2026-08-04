import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect } from "vitest";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";
import { matrixCheckpointing } from "./utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

matrixCheckpointing(
  "resets attempt between steps after a successful retry",
  async (checkpointing) => {
    // When a step succeeds after a retry, subsequent steps get a fresh retry
    // budget.
    //
    // We added this test after discovering that checkpointing prevented the
    // attempt counter from resetting after a successful retry.

    const state = createState({
      aAttempts: [] as number[],
      bAttempts: [] as number[],
    });

    const client = new Inngest({
      checkpointing,
      id: randomSuffix(testFileName),
      isDev: true,
    });
    const eventName = randomSuffix("evt");
    const fn = client.createFunction(
      { id: "fn", retries: 1, triggers: [{ event: eventName }] },
      async (ctx) => {
        state.runId = ctx.runId;
        await ctx.step.run("a", () => {
          state.aAttempts.push(ctx.attempt);
          if (state.aAttempts.length === 1) {
            throw new Error("a: error");
          }
        });
        await ctx.step.run("b", () => {
          state.bAttempts.push(ctx.attempt);
          throw new Error("b: error");
        });
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName });
    await state.waitForRunFailed();

    // Step "a" errors once, then succeeds on retry.
    expect(state.aAttempts).toEqual([0, 1]);

    // Step "b" gets a fresh retry budget (two attempts).
    expect(state.bAttempts).toEqual([0, 1]);
  },
);
