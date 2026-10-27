/**
 * @module
 * Tests for `step.subscribe()`, with a fake server that answers each inbox
 * wait from a queue.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { type OutgoingOp, StepOpCode } from "../../types.ts";
import { _internals } from "../execution/engine.ts";
import { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";

/**
 * Runs `fn` request by request. Each inbox wait is answered with the next
 * queued message, or with a timeout once the queue is empty.
 */
const runWithInbox = async (fn: InngestFunction.Any, queue: unknown[]) => {
  const waits: OutgoingOp[] = [];
  let state: Parameters<typeof runFnWithStack>[1] = {};
  let seq = 0;

  for (let request = 0; request < 30; request++) {
    const result = await runFnWithStack(fn, state);

    if (result.type === "function-resolved") {
      return { waits, output: result.data };
    }

    const found =
      result.type === "step-ran"
        ? [result.step]
        : result.type === "steps-found"
          ? result.steps
          : [];

    for (const op of found) {
      if (op.id === _internals.hashId("complete")) {
        return { waits, output: op.data };
      }

      if (op.op === StepOpCode.WaitForSignal) {
        waits.push(op);
        const next = queue.shift();
        const data =
          next === undefined
            ? null
            : { signal: "inbox", data: { seq: ++seq, data: next } };
        state = { ...state, [op.id]: { id: op.id, data } };
        continue;
      }

      state = { ...state, [op.id]: { id: op.id, data: op.data } };
    }
  }

  throw new Error("The function did not finish");
};

describe("step.subscribe", () => {
  test("delivers queued messages in order, one memoized step each", async () => {
    const client = new Inngest({ id: testClientId });
    const fn = client.createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const seen: unknown[] = [];

        for await (const message of step.subscribe("inbox", { key: "t1" })) {
          seen.push([message.seq, message.data]);
        }

        return seen;
      },
    );

    const { waits, output } = await runWithInbox(fn, ["a", { b: 1 }]);

    expect(output).toEqual([
      [1, "a"],
      [2, { b: 1 }],
    ]);
    expect(waits).toHaveLength(3);
    expect(waits[0]?.opts).toMatchObject({
      signal: "inbox:t1",
      conflict: "replace",
      inbox: { key: "t1" },
    });
    expect(new Set(waits.map((wait) => wait.id)).size).toBe(3);
  });

  test("next() returns null when the wait times out", async () => {
    const client = new Inngest({ id: testClientId });
    const fn = client.createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        return step.subscribe("inbox", { key: "t1", timeout: "1m" }).next();
      },
    );

    const { waits, output } = await runWithInbox(fn, []);

    expect(output).toBeNull();
    expect(waits[0]?.opts).toMatchObject({ timeout: "1m" });
  });
});
