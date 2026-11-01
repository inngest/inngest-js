/**
 * @module
 * The flows of `step.subscribe` views made with `listen()`: sources added
 * mid-run, a view over just them, and nesting. Every flow runs in all 8 cells
 * of the matrix.
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

const listenAddsSources: Flow = {
  name: "inbox-listen",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", {
      event: h.event("a"),
      if: `async.data.key == "${h.key}"`,
    });

    try {
      const view = inbox.listen({
        event: h.event("b"),
        if: `async.data.key == "${h.key}"`,
      });
      h.mark("listening");

      const fromView = n(await view.next());

      // The inbox keeps its own copy of what the view read.
      const fromInbox = n(await inbox.next());

      return { fromView, fromInbox };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.opened("inbox:listen");
    await d.send("a", { n: 1 });
    await sleep(1000);
    await d.send("b", { n: 2 });
  },
  expect: {
    output: { fromView: 2, fromInbox: 1 },
    bodies: {},
    rows: ["inbox", "inbox:listen"],
    steps: 4,
  },
};

const nestedOfUnderListen: Flow = {
  name: "inbox-of-under-listen",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", {
      event: h.event("a"),
      if: `async.data.key == "${h.key}"`,
    });

    try {
      const view = inbox.listen(
        sources(h)
          .slice(1)
          .concat([
            { event: h.event("c"), if: `async.data.key == "${h.key}"` },
          ]),
      );
      const nested = view.of(h.event("c"));

      return { nested: n(await nested.next()) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.opened("inbox:listen");
    await d.send("a", { n: 1 });
    await sleep(300);
    await d.send("b", { n: 2 });
    await sleep(1000);
    await d.send("c", { n: 3 });
  },
  expect: {
    output: { nested: 3 },
    bodies: {},
    rows: ["inbox", "inbox:listen"],
    steps: 5,
  },
};

const listensWithDifferentExpressions: Flow = {
  name: "inbox-two-listens",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", {
      event: h.event("a"),
      if: `async.data.key == "${h.key}" && async.data.n == 0`,
    });

    try {
      const one = inbox.listen({
        event: h.event("b"),
        if: `async.data.key == "${h.key}" && async.data.n == 1`,
      });
      const two = inbox.listen({
        event: h.event("b"),
        if: `async.data.key == "${h.key}" && async.data.n == 2`,
      });

      const [fromOne, fromTwo] = await Promise.all([one.next(), two.next()]);

      return { one: n(fromOne), two: n(fromTwo) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.opened("inbox:listen");
    await d.opened("inbox:listen:1");
    await d.send("b", { n: 2 });
    await sleep(1000);
    await d.send("b", { n: 1 });
  },
  expect: {
    output: { one: 1, two: 2 },
    bodies: {},
    rows: ["inbox", "inbox:listen", "inbox:listen:1"],
    steps: 5,
  },
};

export const inboxListen = flowScenario({
  id: "inbox-listen",
  owner: "sub-06-views",
  flows: [
    listenAddsSources,
    nestedOfUnderListen,
    listensWithDifferentExpressions,
  ],
});
