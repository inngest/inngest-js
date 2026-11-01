/**
 * @module
 * The flows of `step.subscribe` for reads that run in parallel with work or
 * with each other: a read inside `Promise.all` or `Promise.race` with a step,
 * two parallel `next()` calls on one reader, a background `batches()` loop
 * beside work, and a read that lost a race being reused until it wins. Each
 * step body runs once and no run stalls, in all 8 cells of the matrix.
 *
 * The kit loader cannot parse `await using`, so the flows close the inbox in a
 * `finally`.
 */
import {
  type Flow,
  type FlowHandle,
  flowScenario,
  sleep,
} from "../kit/flow.ts";

const source = (h: FlowHandle) => {
  return { event: h.event("msg"), if: `async.data.key == "${h.key}"` };
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

const after = (h: FlowHandle) => {
  return h.step.run("after", async () => {
    h.ran("after");

    return "after-done";
  });
};

const n = (message: unknown) => {
  return (message as { data: { n: number } }).data.n;
};

const allWithStep: Flow = {
  name: "parallel-all",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const [work, message] = await Promise.all([slow(h), inbox.next()]);

      return { work, n: n(message) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("slow:start");
    await d.send("msg", { n: 1 });
  },
  expect: {
    output: { work: "slow-done", n: 1 },
    bodies: { slow: 1 },
    rows: ["inbox", "slow"],
  },
};

const allMessageFirst: Flow = {
  name: "parallel-all-late-step",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const [work, message] = await Promise.all([slow(h), inbox.next()]);

      return { work, n: n(message) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("slow:end");
    await d.send("msg", { n: 1 });
  },
  expect: {
    output: { work: "slow-done", n: 1 },
    bodies: { slow: 1 },
    rows: ["inbox", "slow"],
  },
};

const raceReadWins: Flow = {
  name: "parallel-race-read-wins",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const winner = await Promise.race([slow(h), inbox.next()]);
      const next = await after(h);

      // Which side wins is not asserted: with `optimizeParallelism: false` the
      // step runs inline in the request that reports the read, so it can finish
      // first even though the message arrived while it ran.
      return { settled: winner !== undefined, next };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("slow:start");
    await d.send("msg", { n: 1 });
  },
  expect: {
    output: { settled: true, next: "after-done" },
    bodies: { slow: 1, after: 1 },
    rows: ["after", "inbox", "slow"],
  },
};

const raceStepWins: Flow = {
  name: "parallel-race-step-wins",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const winner = await Promise.race([slow(h), inbox.next()]);
      const next = await after(h);

      // Once the read is answered the replay holds both results, and which one
      // the race settles with there depends on the cell.
      return { settled: winner !== undefined, next };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("slow:end");

    // A read that lost the race still waits, and the run ends once it is
    // answered, so the flow sends it a message.
    await d.send("msg", { n: 1 });
  },
  expect: {
    output: { settled: true, next: "after-done" },
    bodies: { slow: 1, after: 1 },
    rows: ["after", "inbox", "slow"],
  },
};

const twoParallelNexts: Flow = {
  name: "parallel-two-nexts",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const [a, b] = await Promise.all([inbox.next(), inbox.next()]);

      return { a: n(a), b: n(b) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await sleep(1000);
    await d.send("msg", { n: 1 });
    await sleep(1000);
    await d.send("msg", { n: 2 });
  },
  expect: {
    output: { a: 1, b: 2 },
    bodies: {},
    rows: ["inbox"],
  },
};

const twoParallelNextsQueued: Flow = {
  name: "parallel-two-nexts-queued",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      await h.until("sent");

      const [a, b, c] = await Promise.all([
        inbox.next(),
        inbox.next(),
        inbox.next(),
      ]);

      return { ns: [n(a), n(b), n(c)] };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("msg", { n: 1 });
    await sleep(500);
    await d.send("msg", { n: 2 });
    await sleep(500);
    await d.send("msg", { n: 3 });
    await sleep(1000);
    d.mark("sent");
  },
  expect: {
    output: { ns: [1, 2, 3] },
    bodies: {},
    rows: ["inbox"],
  },
};

const twoParallelBatches: Flow = {
  name: "parallel-two-batches",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const [a, b] = await Promise.all([inbox.nextBatch(), inbox.nextBatch()]);

      return { a: a.map(n), b: b.map(n) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await sleep(1000);
    await d.send("msg", { n: 1 });
    await sleep(1000);
    await d.send("msg", { n: 2 });
  },
  expect: {
    output: { a: [1], b: [2] },
    bodies: {},
    rows: ["inbox", "inbox:next:1:batch", "inbox:next:batch"],
  },
};

const backgroundBatches: Flow = {
  name: "parallel-background-batches",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const seen: number[] = [];
      const loop = (async () => {
        for await (const batch of inbox.batches()) {
          for (const message of batch) {
            seen.push(n(message));
          }

          if (seen.length === 3) {
            break;
          }
        }
      })();

      const work = await slow(h);

      await loop;

      return { work, ns: seen.sort() };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("slow:start");
    await d.send("msg", { n: 1 });
    await sleep(500);
    await d.send("msg", { n: 2 });
    await sleep(500);
    await d.send("msg", { n: 3 });
  },
  expect: {
    output: { work: "slow-done", ns: [1, 2, 3] },
    bodies: { slow: 1 },
    rows: [
      "inbox",
      "inbox:next:1:batch",
      "inbox:next:2:batch",
      "inbox:next:batch",
      "slow",
    ],
  },
};

const reuseTheRead: Flow = {
  name: "parallel-reuse-read",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      // The read is made once and reused until it wins: a read that lost the
      // race keeps waiting and takes the next message.
      const work = slow(h);
      const read = inbox.next();
      const first = await Promise.race([work, read]);
      const message = await read;

      return { settled: first !== undefined, n: n(message) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("slow:end");
    await sleep(500);
    await d.send("msg", { n: 1 });
  },
  expect: {
    output: { settled: true, n: 1 },
    bodies: { slow: 1 },
    rows: ["inbox", "slow"],
  },
};

export const inboxParallel = flowScenario({
  id: "inbox-parallel",
  owner: "sub-08-parallel-reads",
  flows: [
    allWithStep,
    allMessageFirst,
    raceReadWins,
    raceStepWins,
    twoParallelNexts,
    twoParallelNextsQueued,
    twoParallelBatches,
    backgroundBatches,
    reuseTheRead,
  ],
});
