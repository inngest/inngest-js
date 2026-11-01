/**
 * @module
 * The tracer flows of `step.subscribe`: open an inbox, read it with nothing
 * unread so the read waits, and wake on a message. Every flow runs in all 8
 * cells of the matrix.
 *
 * An inbox only receives events that arrive after it opens, so the driver waits
 * for the open record to show in the run, then sends each event once.
 *
 * The kit's loader cannot parse `await using`, so the flows close the inbox in
 * a `finally`.
 */
import {
  type Flow,
  type FlowDriver,
  type FlowHandle,
  flowScenario,
} from "../kit/flow.ts";

const source = (h: FlowHandle) => {
  return { event: h.event("msg"), if: `async.data.key == "${h.key}"` };
};

const idleNextThenMessage: Flow = {
  name: "inbox-idle-next",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      h.mark("waiting");
      const message = await inbox.next();
      h.mark("received");

      return { n: (message.data as { n: number }).n };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("msg", { n: 1 });
  },
  expect: {
    output: { n: 1 },
    bodies: {},
    rows: ["inbox"],
    steps: 2,
  },
};

const twoWaits: Flow = {
  name: "inbox-two-waits",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const first = (await inbox.next()).data as { n: number };
      h.mark("got:1");

      const second = (await inbox.next()).data as { n: number };
      h.mark("got:2");

      return { first: first.n, second: second.n };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("msg", { n: 1 });
    await d.reached("got:1");
    await d.send("msg", { n: 2 });
  },
  expect: {
    output: { first: 1, second: 2 },
    bodies: {},
    rows: ["inbox"],
    steps: 3,
  },
};

export const inboxNext = flowScenario({
  id: "inbox-next",
  owner: "sub-02-tracer-open-next-wake",
  flows: [idleNextThenMessage, twoWaits],
});
