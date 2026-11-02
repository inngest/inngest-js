/**
 * @module
 * The flows of several inboxes in one run: a second `step.subscribe` opens a
 * named inbox of its own, which an agent's `inbox_listen` does. Each inbox has
 * its own reader, closing one leaves the others reading, and two inboxes on
 * one event with different expressions each get only their messages. Every
 * flow runs in all 8 cells of the matrix.
 *
 * The kit loader cannot parse `await using`, so the flows close each inbox in
 * a `finally`.
 */
import { type Flow, flowScenario, sleep } from "../kit/flow.ts";

const n = (message: { data?: unknown } | undefined) => {
  return (message?.data as { n: number }).n;
};

const twoInboxes: Flow = {
  name: "inbox-two-inboxes",
  run: async (h) => {
    const first = h.step.subscribe("first", {
      event: h.event("a"),
      if: `async.data.key == "${h.key}"`,
    });
    const second = h.step.subscribe("second", {
      event: h.event("b"),
      if: `async.data.key == "${h.key}"`,
    });

    try {
      const fromSecond = n(await second.next());
      const unread = (await second.close()).length;
      const fromFirst = n(await first.next());

      return { fromSecond, unread, fromFirst, secondClosed: second.closed };
    } finally {
      await first.close();
    }
  },
  drive: async (d) => {
    await d.opened("first");
    await d.opened("second");
    await d.send("b", { n: 2 });
    await sleep(1000);
    await d.send("a", { n: 1 });
  },
  expect: {
    output: { fromSecond: 2, unread: 0, fromFirst: 1, secondClosed: true },
    bodies: {},
    ended: ["first", "second"],
    rows: [
      "first",
      "first:close",
      "first:next",
      "second",
      "second:close",
      "second:next",
    ],
    steps: 6,
  },
};

const sameEventTwoExpressions: Flow = {
  name: "inbox-two-expressions",
  run: async (h) => {
    const one = h.step.subscribe("one", {
      event: h.event("b"),
      if: `async.data.key == "${h.key}" && async.data.n == 1`,
    });
    const two = h.step.subscribe("two", {
      event: h.event("b"),
      if: `async.data.key == "${h.key}" && async.data.n == 2`,
    });

    try {
      const [fromOne, fromTwo] = await Promise.all([one.next(), two.next()]);

      return { one: n(fromOne), two: n(fromTwo) };
    } finally {
      await one.close();
      await two.close();
    }
  },
  drive: async (d) => {
    await d.opened("one");
    await d.opened("two");
    await d.send("b", { n: 2 });
    await sleep(1000);
    await d.send("b", { n: 1 });
  },
  expect: {
    output: { one: 1, two: 2 },
    bodies: {},
    ended: ["one", "two"],
    rows: ["one", "one:close", "one:next", "two", "two:close", "two:next"],
    steps: 6,
  },
};

export const inboxNamed = flowScenario({
  id: "inbox-named",
  owner: "sub-29-agents-one-inbox",
  flows: [twoInboxes, sameEventTwoExpressions],
});
