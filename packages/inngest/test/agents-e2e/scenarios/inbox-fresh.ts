/**
 * @module
 * Batch reads see what has arrived, even in a long checkpointed request: a
 * message that arrives while a slow step runs in process is returned by the
 * `drain()` that follows it, and `nextBatch()` after it returns everything
 * unread. All 8 cells of the matrix.
 *
 * The kit loader cannot parse `await using`, so the flows close the inbox in a
 * `finally`.
 */
import type { Flow, FlowHandle } from "../kit/flow.ts";
import { flowScenario, sleep } from "../kit/flow.ts";

const source = (h: FlowHandle) => {
  return { event: h.event("msg"), if: `async.data.key == "${h.key}"` };
};

const numbers = (messages: ({ data?: unknown } | undefined)[]) => {
  return messages.map((message) => {
    return (message?.data as { n: number }).n;
  });
};

const slow = (h: FlowHandle) => {
  return h.step.run("slow", async () => {
    h.ran("slow");
    h.mark("slow:start");
    await sleep(2000);
    h.mark("slow:end");

    return "slow-done";
  });
};

const drainAfterSlow: Flow = {
  name: "inbox-fresh-drain",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const first = await inbox.next();
      await slow(h);
      const drained = await inbox.drain();
      const empty = await inbox.drain();

      return {
        first: numbers([first]),
        drained: numbers(drained),
        empty: numbers(empty),
      };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("msg", { n: 1 });
    await d.reached("slow:start");
    await d.send("msg", { n: 2 });
    await d.reached("slow:end");
  },
  expect: {
    output: { first: [1], drained: [2], empty: [] },
    bodies: { slow: 1 },
  },
};

const batchAfterSlow: Flow = {
  name: "inbox-fresh-batch",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const first = await inbox.next();
      await slow(h);
      const batch = await inbox.nextBatch();

      // Events sent together are saved in the order they reach the executor.
      return {
        first: numbers([first]),
        batch: numbers(batch ?? []).sort((a, b) => {
          return a - b;
        }),
      };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("msg", { n: 1 });
    await d.reached("slow:start");
    await d.sendAll("msg", [{ n: 2 }, { n: 3 }]);
    await d.reached("slow:end");
  },
  expect: {
    output: { first: [1], batch: [2, 3] },
    bodies: { slow: 1 },
  },
};

export const inboxFresh = flowScenario({
  id: "inbox-fresh",
  owner: "sub-16-batch-reads-ask",
  flows: [drainAfterSlow, batchAfterSlow],
});
