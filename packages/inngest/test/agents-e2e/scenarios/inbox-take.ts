/**
 * @module
 * The flows of the internal take hook of `step.subscribe`: inside a step's
 * body, a reader takes the messages it has not read, and their ids ride in
 * that step's saved output. A replay moves the reader past them at the step's
 * place. The step returns to its caller exactly what its body returned. Every
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
  return [
    { event: h.event("a"), if: `async.data.key == "${h.key}"` },
    { event: h.event("b"), if: `async.data.key == "${h.key}"` },
  ];
};

const numbers = (messages: { data?: unknown }[] | undefined) => {
  return (messages ?? [])
    .map((message) => {
      return (message.data as { n: number }).n;
    })
    .sort((a, b) => {
      return a - b;
    });
};

const takeBetweenReads: Flow = {
  name: "take-between-reads",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const first = await inbox.next();

      h.mark("first");
      await h.until("sent");

      // A new request, so the take loads the messages that arrived.
      await h.step.sleep("nap", "1s");

      const turn = await inbox.takeIn("model", (fresh) => {
        h.ran("model");

        return { reply: "ok", seen: numbers(fresh) };
      });

      h.mark("took");

      const last = await inbox.next();

      return {
        first: numbers([first as { data: unknown }]),
        turn,
        last: numbers([last as { data: unknown }]),
      };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("a", { n: 1 });
    await d.reached("first");
    await d.sendAll("a", [{ n: 2 }, { n: 3 }]);
    await sleep(1000);
    d.mark("sent");
    await d.reached("took");
    await d.send("a", { n: 4 });
  },
  expect: {
    output: {
      first: [1],
      turn: { reply: "ok", seen: [2, 3] },
      last: [4],
    },
    bodies: { model: 1 },
    rows: [
      "inbox",
      "inbox:close",
      "inbox:next",
      "inbox:next:2",
      "model",
      "nap",
    ],
    ticks: { inbox: 4, model: 2, "inbox:next": 1, "inbox:next:2": 1 },

    // The open record, four messages, the nap, the take step and the close.
    steps: 8,
  },
};

const takeNothing: Flow = {
  name: "take-nothing",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const turn = await inbox.takeIn("model", (fresh) => {
        h.ran("model");

        return { reply: "ok", seen: numbers(fresh) };
      });

      return { turn };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
  },
  expect: {
    output: { turn: { reply: "ok", seen: [] } },
    bodies: { model: 1 },
    rows: ["inbox", "inbox:close", "model"],

    // The open record, the take step and the close. An empty take adds nothing.
    steps: 3,
  },
};

const attempts = new Map<string, number>();

const takeRetried: Flow = {
  name: "take-retried",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      await h.until("first");
      await h.step.sleep("nap", "1s");

      const turn = await inbox.takeIn("model", async (fresh) => {
        h.ran("model");

        const attempt = attempts.get(h.key) ?? 0;
        attempts.set(h.key, attempt + 1);

        if (attempt === 0) {
          h.mark("took-then-failed");
          await h.until("second");

          throw new Error("first attempt fails");
        }

        return { seen: numbers(fresh) };
      });

      // Nothing is left unread: the retry took what the failed attempt saw
      // and what arrived after.
      const rest = await inbox.close();

      return { turn, rest: rest.length };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("a", { n: 1 });
    await sleep(1000);
    d.mark("first");
    await d.reached("took-then-failed");
    await d.send("a", { n: 2 });
    await sleep(1000);
    d.mark("second");
  },
  expect: {
    output: { turn: { seen: [1, 2] }, rest: 0 },
    bodies: { model: 2 },
    rows: ["inbox", "inbox:close", "model", "nap"],
    ticks: { inbox: 2, model: 2 },
  },
};

const takeBesideBackgroundLoop: Flow = {
  name: "take-beside-batches-loop",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const seen: number[] = [];

      const loop = (async () => {
        for await (const batch of inbox.of(h.event("b")).batches()) {
          seen.push(...numbers(batch));

          if (seen.length >= 2) {
            return;
          }
        }
      })();

      // Arrives after the other message, so the take loads both.
      await inbox.of(h.event("a")).next();

      const turn = await inbox.takeIn("model", (fresh) => {
        h.ran("model");

        return { seen: numbers(fresh) };
      });

      h.mark("took");
      await loop;

      return { turn, background: seen.sort() };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("b", { n: 2 });
    await sleep(1000);
    await d.send("a", { n: 1 });
    await d.reached("took");
    await d.send("b", { n: 3 });
  },
  expect: {
    output: { turn: { seen: [1, 2] }, background: [2, 3] },
    bodies: { model: 1 },
  },
};

export const inboxTake = flowScenario({
  id: "inbox-take",
  owner: "sub-15-take-inside-a-step",
  flows: [takeBetweenReads, takeNothing, takeRetried, takeBesideBackgroundLoop],
});
