/**
 * @module
 * The flows of `step.subscribe` for closing: `close()` returns the handle's
 * unread messages, stops its sources, and ends every read waiting under it
 * with `undefined`. Closing a `listen` view keeps the inbox's copies, closing
 * an `of()` view ends only that reader, and closing the inbox closes its
 * views. Every flow runs in all 8 cells of the matrix.
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

    return {
      read,
      unread: numbers(unread),
      closed: inbox.closed,
      ended: after === undefined,
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
    output: { read: 1, unread: [2, 3], closed: true, ended: true },
    bodies: {},
    rows: ["inbox", "inbox:close"],
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
    rows: ["inbox", "inbox:close"],
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
    rows: ["inbox", "inbox:close"],
    steps: 2,
  },
};

const closingListenKeepsInboxCopies: Flow = {
  name: "inbox-close-listen",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", when(h, "a"));
    const view = inbox.listen(when(h, "b"));

    await h.until("sent");

    // The first read has nothing in the state this request loaded, so it
    // reports a wait and the next request loads every message sent.
    const first = n(await inbox.next());
    const fromView = numbers(await view.close());
    h.mark("viewClosed");

    const second = n(await inbox.next());
    const third = n(await inbox.next());
    const rest = numbers(await inbox.close());

    return { fromView, first, second, third, rest, viewClosed: view.closed };
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.opened("inbox:listen");
    await d.send("a", { n: 1 });
    await sleep(300);
    await d.send("b", { n: 2 });
    await sleep(1000);
    d.mark("sent");
    await d.reached("viewClosed");
    await d.send("b", { n: 3 });
    await sleep(300);
    await d.send("a", { n: 4 });
  },
  expect: {
    output: {
      fromView: [2],
      first: 1,
      second: 2,
      third: 4,
      rest: [],
      viewClosed: true,
    },
    bodies: {},
    rows: ["inbox", "inbox:listen", "inbox:listen:close", "inbox:close"],
    steps: 7,
  },
};

const closingOfEndsOnlyThatReader: Flow = {
  name: "inbox-close-of",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", [when(h, "a"), when(h, "b")]);
    const view = inbox.of(h.event("a"));

    await h.until("sent");

    const got: number[] = [n(await inbox.next())];
    const fromView = numbers(await view.close());
    const viewEnded = (await view.next()) === undefined;
    h.mark("viewClosed");

    while (got.length < 4) {
      got.push(n(await inbox.next()));
    }
    const rest = numbers(await inbox.close());

    return { fromView, viewEnded, viewClosed: view.closed, got, rest };
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("a", { n: 1 });
    await sleep(300);
    await d.send("b", { n: 2 });
    await sleep(300);
    await d.send("a", { n: 3 });
    await sleep(1000);
    d.mark("sent");
    await d.reached("viewClosed");
    await d.send("a", { n: 4 });
  },
  expect: {
    output: {
      fromView: [1, 3],
      viewEnded: true,
      viewClosed: true,
      got: [1, 2, 3, 4],
      rest: [],
    },
    bodies: {},
    rows: ["inbox", "inbox:close", "inbox:of:agents-e2e/inbox-close/a:close"],
    steps: 7,
  },
};

const closingInboxClosesViews: Flow = {
  name: "inbox-close-views",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", [when(h, "a"), when(h, "b")]);
    const view = inbox.of(h.event("a"));

    await h.until("sent");

    const first = n(await inbox.next());
    const fromInbox = numbers(await inbox.close());
    const viewClosed = view.closed;
    const viewEnded = (await view.next()) === undefined;
    const fromView = numbers(await view.close());

    return { first, fromInbox, viewClosed, viewEnded, fromView };
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
    output: {
      first: 1,
      fromInbox: [2],
      viewClosed: true,
      viewEnded: true,
      fromView: [1],
    },
    bodies: {},
    rows: ["inbox", "inbox:close", "inbox:of:agents-e2e/inbox-close/a:close"],
    steps: 5,
  },
};

export const inboxClose = flowScenario({
  id: "inbox-close",
  owner: "sub-07-close",
  flows: [
    closeReturnsUnread,
    closeEndsBackgroundLoop,
    closeEndsTimedRead,
    closingListenKeepsInboxCopies,
    closingOfEndsOnlyThatReader,
    closingInboxClosesViews,
  ],
});
