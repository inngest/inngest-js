/**
 * @module
 * The tracer flows of `step.subscribe`: open an inbox, read it with nothing
 * unread so the read waits, and wake on a message. Every flow runs in all 8
 * cells of the matrix.
 *
 * An inbox only receives events that arrive after it opens, and nothing the
 * function can observe tells the driver the open has been handled. So the
 * driver sends its message again until the function has read it. Messages
 * that nobody reads are saved and ignored.
 *
 * The kit's loader cannot parse `await using`, so the flows close the inbox in
 * a `finally`.
 */
import {
  type Flow,
  type FlowDriver,
  type FlowHandle,
  flowScenario,
  sleep,
} from "../kit/flow.ts";

/**
 * Sends `n` every 500ms until the function has marked `line`.
 */
const sendUntil = async (d: FlowDriver, n: number, line: string) => {
  let reached = false;
  const done = d.reached(line).then(() => {
    reached = true;
  });

  while (!reached) {
    await d.send("msg", { n });
    await Promise.race([done, sleep(500)]);
  }
};

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
    await sendUntil(d, 1, "received");
  },
  expect: {
    output: { n: 1 },
    bodies: {},
    rows: ["inbox"],
  },
};

const twoWaits: Flow = {
  name: "inbox-two-waits",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const first = (await inbox.next()).data as { n: number };
      h.mark("got:1");

      // Copies of the first message may have arrived while the driver was
      // sending it again; skip them.
      let second = (await inbox.next()).data as { n: number };
      while (second.n === first.n) {
        second = (await inbox.next()).data as { n: number };
      }
      h.mark("got:2");

      return { first: first.n, second: second.n };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await sendUntil(d, 1, "got:1");
    await sendUntil(d, 2, "got:2");
  },
  expect: {
    output: { first: 1, second: 2 },
    bodies: {},
    rows: ["inbox"],
  },
};

export const inboxNext = flowScenario({
  id: "inbox-next",
  owner: "sub-02-tracer-open-next-wake",
  flows: [idleNextThenMessage, twoWaits],
});
