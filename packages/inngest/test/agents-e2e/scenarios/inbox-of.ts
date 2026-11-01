/**
 * @module
 * The flows of `step.subscribe` views made with `of()`: one kind of event, the same
 * filter is the same reader, and every reader sees every message it matches. Every flow runs in all 8 cells of the matrix.
 *
 * The driver waits for the open record (and a listen's record) to show in the
 * run, then sends each event once. The kit loader cannot parse `await using`,
 * so the flows close the inbox in a `finally`.
 */
import {
  type Flow,
  type FlowHandle,
  flowScenario,
  sleep,
} from "../kit/flow.ts";

const sources = (h: FlowHandle) => {
  return [
    { event: h.event("a"), if: `async.data.key == "${h.key}"` },
    { event: h.event("b"), if: `async.data.key == "${h.key}"` },
  ];
};

const n = (message: { data?: unknown }) => {
  return (message.data as { n: number }).n;
};

const ofSkipsOtherTypes: Flow = {
  name: "inbox-of-skips",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", sources(h));

    try {
      const view = inbox.of(h.event("a"));
      h.mark("waiting");
      const fromView = n(await view.next());
      const fromInbox = n(await inbox.next());

      return { fromView, fromInbox };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("b", { n: 1 });
    await d.reached("waiting");
    await sleep(1000);
    await d.send("a", { n: 2 });
  },
  expect: {
    output: { fromView: 2, fromInbox: 1 },
    bodies: {},
    rows: ["inbox"],
    steps: 3,
  },
};

const twoViewsInParallel: Flow = {
  name: "inbox-two-views",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", sources(h));

    try {
      const [a, b] = await Promise.all([
        inbox.of(h.event("a")).next(),
        inbox.of(h.event("b")).next(),
      ]);

      return { a: n(a), b: n(b) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("b", { n: 1 });
    await sleep(1000);
    await d.send("a", { n: 2 });
  },
  expect: {
    output: { a: 2, b: 1 },
    bodies: {},
    rows: ["inbox"],
    steps: 3,
  },
};

const sameFilterSameReader: Flow = {
  name: "inbox-same-reader",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", sources(h));

    try {
      await h.until("sent");

      const first = n(await inbox.of(h.event("a")).next());
      const second = n(await inbox.of([h.event("a")]).next());

      return {
        first,
        second,
        same: inbox.of(h.event("a")) === inbox.of(h.event("a")),
      };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("a", { n: 1 });
    await sleep(300);
    await d.send("a", { n: 2 });
    await sleep(1000);
    d.mark("sent");
  },
  expect: {
    output: { first: 1, second: 2, same: true },
    bodies: {},
    rows: ["inbox"],
    steps: 3,
  },
};

const viewReadsFromTheStart: Flow = {
  name: "inbox-view-from-start",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", sources(h));

    try {
      await h.until("sent");

      const root = n(await inbox.next());

      // The view is made after the inbox has read a message, and still starts
      // at the first message it matches.
      const view = n(await inbox.of(h.event("b")).next());

      return { root, view };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("a", { n: 1 });
    await sleep(300);
    await d.send("b", { n: 2 });
    await sleep(1000);
    d.mark("sent");
  },
  expect: {
    output: { root: 1, view: 2 },
    bodies: {},
    rows: ["inbox"],
    steps: 3,
  },
};

const viewBatchTakesOnlyItsMessages: Flow = {
  name: "inbox-view-batch",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", sources(h));

    try {
      // A step ends the request, so the drains below load the messages.
      await h.step.run("hold", async () => {
        h.ran("hold");
        await h.until("sent");
      });

      const view = await inbox.of(h.event("a")).drain();
      const root = await inbox.drain();

      await h.step.sleep("end", "1s");

      // Events sent together can be saved in any order, so only the sets are
      // asserted.
      return { view: view.map(n).sort(), root: root.map(n).sort() };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.sendAll("a", [{ n: 1 }, { n: 3 }]);
    await d.sendAll("b", [{ n: 2 }]);
    await sleep(1000);
    d.mark("sent");
  },
  expect: {
    output: { view: [1, 3], root: [1, 2, 3] },
    bodies: { hold: 1 },
    rows: [
      "end",
      "hold",
      "inbox",
      "inbox:next:batch",
      "inbox:of:agents-e2e/inbox-of/a:next:batch",
    ],
    steps: 8,
  },
};

export const inboxOf = flowScenario({
  id: "inbox-of",
  owner: "sub-06-views",
  flows: [
    ofSkipsOtherTypes,
    twoViewsInParallel,
    sameFilterSameReader,
    viewReadsFromTheStart,
    viewBatchTakesOnlyItsMessages,
  ],
});
