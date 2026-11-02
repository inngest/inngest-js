/**
 * @module
 * The flows of `step.subscribe` for closing: `close()` returns the handle's
 * unread messages, stops its sources, and ends every read waiting under it
 * with `undefined`. Every flow runs in all 8 cells of the matrix.
 *
 * The kit loader cannot parse `await using`, so the flows call `close()`
 * themselves; the unit test of `Inbox` covers `await using`.
 */
import {
  type Flow,
  type FlowHandle,
  flowScenario,
  sleep,
} from "../kit/flow.ts";

const when = (h: FlowHandle, name: string) => {
  return { event: h.event(name), if: `async.data.key == "${h.key}"` };
};

const n = (message: { data?: unknown } | undefined) => {
  return (message?.data as { n: number }).n;
};

const numbers = (messages: ({ data?: unknown } | undefined)[]) => {
  return messages.map(n);
};

const closeReturnsUnread: Flow = {
  name: "inbox-close-unread",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", when(h, "msg"));

    await h.until("sent");

    const read = n(await inbox.next());
    const unread = await inbox.close();
    const after = await inbox.next();
    const batchEnded = (await inbox.nextBatch()) === undefined;
    const drained = (await inbox.drain()).length;

    return {
      read,
      unread: numbers(unread),
      closed: inbox.closed,
      ended: after === undefined,
      batchEnded,
      drained,
    };
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("msg", { n: 1 });
    await sleep(300);
    await d.send("msg", { n: 2 });
    await sleep(300);
    await d.send("msg", { n: 3 });
    await sleep(1000);
    d.mark("sent");
  },
  expect: {
    output: {
      read: 1,
      unread: [2, 3],
      closed: true,
      ended: true,
      batchEnded: true,
      drained: 0,
    },
    bodies: {},
    ended: ["inbox"],
    rows: ["inbox", "inbox:close", "inbox:next"],
    steps: 5,
  },
};

const closeEndsBackgroundLoop: Flow = {
  name: "inbox-close-loop",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", when(h, "msg"));

    await h.until("sent");

    const got: number[] = [];
    const loop = (async () => {
      for await (const message of inbox) {
        got.push(n(message));
      }

      return "ended";
    })();

    const unread = await inbox.close();

    return { got, unread: numbers(unread), loop: await loop };
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("msg", { n: 1 });
    await sleep(300);
    await d.send("msg", { n: 2 });
    await sleep(1000);
    d.mark("sent");
  },
  expect: {
    output: { got: [1, 2], unread: [], loop: "ended" },
    bodies: {},
    rows: ["inbox", "inbox:close", "inbox:next", "inbox:next:1"],
    steps: 4,
  },
};

const closeEndsTimedRead: Flow = {
  name: "inbox-close-waiting",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", when(h, "msg"));

    const waiting = inbox.next({ timeout: "5m" });
    const unread = await inbox.close();

    return {
      unread: numbers(unread),
      ended: (await waiting) === undefined,
      closed: inbox.closed,
    };
  },
  drive: async (d) => {
    await d.opened("inbox");
  },
  expect: {
    output: { unread: [], ended: true, closed: true },
    bodies: {},
    rows: ["inbox", "inbox:close", "inbox:next"],
    steps: 2,
  },
};

const neverClosed: Flow = {
  name: "inbox-never-closed",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", when(h, "a"));

    return { first: n(await inbox.next()) };
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("a", { n: 1 });
  },
  expect: {
    output: { first: 1 },
    bodies: {},
    rows: ["inbox", "inbox:next"],
    ended: ["inbox"],
  },
};

export const inboxClose = flowScenario({
  id: "inbox-close",
  owner: "sub-07-close",
  flows: [
    neverClosed,
    closeReturnsUnread,
    closeEndsBackgroundLoop,
    closeEndsTimedRead,
  ],
});
