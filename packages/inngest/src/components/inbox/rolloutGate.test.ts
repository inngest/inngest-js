/**
 * @module
 * Tests that `step.subscribe` is refused at once when the executor did not say
 * it supports inboxes, and runs as before when it did or when nothing is known.
 */
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, test } from "vitest";
import { createClient } from "../../test/helpers.ts";
import { StepMode } from "../../types.ts";
import { InngestFunction } from "../InngestFunction.ts";

const run = async (executorCapabilities?: string[]) => {
  const client = createClient({ id: "test" });

  const fn = new InngestFunction(
    client,
    { id: "gate", triggers: [{ event: "foo" }] },
    async ({ step }) => {
      step.subscribe("inbox", "msg");

      return "done";
    },
  );

  const execution = fn["createExecution"]({
    partialOptions: {
      client,
      data: fromPartial({ event: { name: "foo", data: {} } }),
      runId: "run",
      stepState: {},
      stepCompletionOrder: [],
      reqArgs: [],
      headers: {},
      stepMode: StepMode.Async,
      executorCapabilities,
    },
  });

  return execution.start();
};

describe("step.subscribe rollout gate", () => {
  test("fails without retrying when the executor lists no capabilities", async () => {
    const ret = await run([]);

    expect(ret.type).toBe("function-rejected");
    expect(ret).toMatchObject({
      retriable: false,
      error: expect.objectContaining({
        message: expect.stringContaining("step.subscribe"),
      }),
    });
  });

  test("runs when the executor lists the subscribe capability", async () => {
    const ret = await run(["subscribe"]);

    expect(ret.type).toBe("steps-found");
  });

  test("runs when nothing is known about the executor", async () => {
    const ret = await run(undefined);

    expect(ret.type).toBe("steps-found");
  });
});
