/**
 * @module
 * The timeout flows of `step.subscribe`: `next({ timeout })` returns `null`
 * when nothing arrives in time, a message that arrives first cancels the
 * timeout, and a timeout does not change what a later read returns. Every flow
 * runs in all 8 cells of the matrix.
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

const timeoutWithNoMessage: Flow = {
  name: "inbox-timeout-no-message",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const message = await inbox.next({ timeout: "3s" });

      return { message };
    } finally {
      await inbox.close();
    }
  },
  drive: async () => {
    return undefined;
  },
  expect: {
    output: { message: null },
    bodies: {},
    rows: ["inbox"],
  },
};

const messageBeforeTimeout: Flow = {
  name: "inbox-message-before-timeout",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      h.mark("waiting");
      const message = await inbox.next({ timeout: "1m" });
      h.mark("received");

      return { n: (message?.data as { n: number } | undefined)?.n };
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

// A message that arrives after a read timed out is not that read's: replaying
// the run must still return the null first, then the message to the next read.
const timeoutThenMessage: Flow = {
  name: "inbox-timeout-then-message",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      const first = await inbox.next({ timeout: "3s" });
      h.mark("timed-out");

      const second = await inbox.next();
      h.mark("received");

      return { first, n: (second.data as { n: number }).n };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.reached("timed-out");
    await sendUntil(d, 1, "received");
  },
  expect: {
    output: { first: null, n: 1 },
    bodies: {},
    rows: ["inbox"],
  },
};

export const inboxTimeouts = flowScenario({
  id: "inbox-timeouts",
  owner: "sub-04-timeouts",
  flows: [timeoutWithNoMessage, messageBeforeTimeout, timeoutThenMessage],
});
