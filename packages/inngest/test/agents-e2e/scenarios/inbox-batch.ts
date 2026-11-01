/**
 * @module
 * The flows of `step.subscribe` for reading messages in batches: `nextBatch`
 * waits for at least one and takes every unread message, `drain` takes them
 * without waiting, `batches()` loops over batches and `max` leaves the rest
 * unread. Each batch read saves one step that lists the messages it took. Every
 * flow runs in all 8 cells of the matrix.
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

const numbers = (messages: { data?: unknown }[]) => {
  return messages
    .map((message) => {
      return (message.data as { n: number }).n;
    })
    .sort((a, b) => {
      return a - b;
    });
};

const burstThenBatch: Flow = {
  name: "batch-burst",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      await h.step.run("work", async () => {
        h.ran("work");
        await h.until("sent");
      });

      const batch = await inbox.nextBatch();

      // A last request, which loads every step the run holds, so the tally
      // reads the same in all cells.
      await h.step.sleep("end", "1s");

      return { ns: numbers(batch) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.sendAll("msg", [{ n: 1 }, { n: 2 }, { n: 3 }]);
    await sleep(1000);
    d.mark("sent");
  },
  expect: {
    output: { ns: [1, 2, 3] },
    bodies: { work: 1 },
    rows: ["end", "inbox", "inbox:next:batch", "work"],
    ticks: { inbox: 3, "inbox:next:batch": 3 },

    // The open record, the work, three messages, the one batch record and
    // the last sleep.
    steps: 7,
  },
};

const maxLeavesTheRest: Flow = {
  name: "batch-max",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      await h.until("sent");

      const first = await inbox.nextBatch({ max: 2 });
      const rest = await inbox.drain();
      const none = await inbox.drain();

      await h.step.sleep("end", "1s");

      // Events sent together can be saved in any order, so which message is
      // first is not asserted.
      return {
        first: first.length,
        rest: rest.length,
        none: none.length,
        all: numbers([...first, ...rest]),
      };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.sendAll("msg", [{ n: 1 }, { n: 2 }, { n: 3 }]);
    await sleep(1000);
    d.mark("sent");
  },
  expect: {
    output: { first: 2, rest: 1, none: 0, all: [1, 2, 3] },
    bodies: {},
    rows: [
      "end",
      "inbox",
      "inbox:next",
      "inbox:next:1:batch",
      "inbox:next:2:batch",
      "inbox:next:batch",
    ],

    // The open record, three messages, three batch records and the last
    // sleep. The empty drain saves its record too.
    steps: 8,
  },
};

const batchWaits: Flow = {
  name: "batch-waits",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const batch = await inbox.nextBatch();

      return { ns: numbers(batch) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await sleep(1000);
    await d.send("msg", { n: 1 });
  },
  expect: {
    output: { ns: [1] },
    bodies: {},
    rows: ["inbox", "inbox:next", "inbox:next:batch"],
    ticks: { inbox: 1, "inbox:next:batch": 1 },
  },
};

const emptyDrain: Flow = {
  name: "batch-empty-drain",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const none = await inbox.drain();

      h.mark("drained");
      await h.until("sent");

      // A new request, so the second drain loads the message that arrived.
      await h.step.sleep("nap", "1s");

      const some = await inbox.drain();

      await h.step.sleep("end", "1s");

      return { none: none.length, some: numbers(some) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.reached("drained");
    await d.send("msg", { n: 1 });
    await sleep(1000);
    d.mark("sent");
  },
  expect: {
    output: { none: 0, some: [1] },
    bodies: {},
    rows: ["end", "inbox", "inbox:next:batch", "inbox:next:1:batch", "nap"],

    // The open record, one message, two batch records and two sleeps.
    steps: 6,
  },
};

const batchesLoop: Flow = {
  name: "batch-loop",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      await h.until("sent");

      const sizes: number[] = [];
      let total = 0;

      for await (const batch of inbox.batches({ max: 2 })) {
        sizes.push(batch.length);
        total += batch.length;

        if (total === 5) {
          break;
        }
      }

      return { sizes };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.sendAll(
      "msg",
      [1, 2, 3, 4, 5].map((n) => {
        return { n };
      }),
    );
    await sleep(1000);
    d.mark("sent");
  },
  expect: {
    output: { sizes: [2, 2, 1] },
    bodies: {},
    rows: [
      "inbox",
      "inbox:next",
      "inbox:next:1:batch",
      "inbox:next:2:batch",
      "inbox:next:batch",
    ],
    ticks: {
      inbox: 5,
      "inbox:next:batch": 2,
      "inbox:next:1:batch": 2,
      "inbox:next:2:batch": 1,
    },
  },
};

export const inboxBatch = flowScenario({
  id: "inbox-batch",
  owner: "sub-05-batch-reads",
  flows: [
    burstThenBatch,
    maxLeavesTheRest,
    batchWaits,
    emptyDrain,
    batchesLoop,
  ],
});
