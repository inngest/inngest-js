/**
 * @module
 * The thread recorder's writes are steps with distinct IDs, so the engine
 * never warns about duplicate step IDs.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { _internals } from "../execution/engine.ts";
import { Inngest } from "../Inngest.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { threadRecorder } from "./threadState.ts";

const event = {
  name: "agent/message",
  data: { agent: "a/b", thread: "t1", kind: "user", content: "hi" },
};

const pause = () => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });
};

// Runs the function request by request, the way the executor does: each
// request reports one step, which the next request carries as memoized.
const runToEnd = async (
  fn: Parameters<typeof runFnWithStack>[0],
): Promise<string[]> => {
  const stack: Record<string, { id: string; data: unknown }> = {};

  for (let request = 0; request < 50; request++) {
    const result = await runFnWithStack(fn, stack, { event });

    if (result.type === "function-resolved") {
      return Object.values(stack).map((found) => {
        return found.id;
      });
    }

    if (result.type !== "step-ran") {
      throw new Error(`unexpected ${result.type}`);
    }

    stack[result.step.id] = { id: result.step.id, data: result.step.data };
  }

  throw new Error("the function never ended");
};

describe.each([true, false])(
  "recorder step IDs (optimizeParallelism %s)",
  (optimizeParallelism) => {
    test("repeated state writes do not warn about duplicate step IDs", async () => {
      const warn = vi.fn();
      const client = new Inngest({
        id: testClientId,
        optimizeParallelism,
        logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
      });
      const store = createKv({ adapter: memoryKvAdapter() });
      const fn = client.createFunction(
        { id: "recorder", triggers: [{ event: "agent/message" }] },
        async ({ runId }) => {
          const recorder = threadRecorder(store, runId);

          await recorder.running();
          await pause();
          await recorder.waiting();
          await pause();
          await recorder.running();
          await pause();
          await recorder.turn({
            turn: 1,
            stepId: "m",
            text: "x",
            toolCalls: [],
            usage: { input: 1, output: 1 },
          });
          await pause();
          await recorder.waiting();
        },
      );

      const ids = await runToEnd(fn);

      // The IDs are the ones the engine indexes repeats to, so a run that began
      // before the fix replays against the same steps.
      const base = _internals.hashId("kv.update:thread:__state");

      expect(ids).toEqual([
        base,
        ...[1, 2, 3, 4].map((n) => {
          return _internals.hashId(`kv.update:thread:__state:${n}`);
        }),
      ]);

      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        "Duplicate step ID",
      );
    });
  },
);

describe("the message in flight", () => {
  test("a honored stop clears it, so a later failure resends nothing", async () => {
    const client = new Inngest({ id: testClientId });
    const store = createKv({ adapter: memoryKvAdapter() });
    const seen: unknown[] = [];
    const fn = client.createFunction(
      { id: "recorder", triggers: [{ event: "agent/message" }] },
      async ({ runId }) => {
        const recorder = threadRecorder(store, runId);

        await recorder.running(undefined, { content: "do it" });
        seen.push((await recorder.stopped()).inflight);
      },
    );

    await runToEnd(fn);

    expect(seen.at(-1)).toBeUndefined();
  });
});
