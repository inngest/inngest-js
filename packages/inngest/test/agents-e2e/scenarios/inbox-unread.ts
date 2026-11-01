/**
 * @module
 * The flows of `step.subscribe` for messages that arrive while the code is
 * occupied: unread messages are read in process, a plain loop over N messages costs
 * N + 1 steps, a lookalike step is not a message, and one event matching two
 * sources is one message. Every flow runs in all 8 cells of the matrix.
 *
 * The driver waits for the open record to show in the run, then sends each
 * event once. The kit loader cannot parse `await using`, so the flows close the
 * inbox in a `finally`.
 */
import { createHash } from "node:crypto";
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

const upTo = (n: number) => {
  return Array.from({ length: n }, (_, i) => {
    return i + 1;
  });
};

const unreadMessages: Flow = {
  name: "inbox-unread",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));

    try {
      // The function is held until the driver has sent all three messages.
      await h.until("sent");

      const got = [];
      for (let i = 0; i < 3; i++) {
        got.push(await inbox.next());
      }

      return { ns: numbers(got) };
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
    bodies: {},
    rows: ["inbox"],
    steps: 4,
  },
};

const loopOf = (n: number): Flow => {
  return {
    name: `inbox-loop-${n}`,
    run: async (h) => {
      const inbox = h.step.subscribe("inbox", source(h));

      try {
        const got = [];
        for await (const message of inbox) {
          got.push(message);

          if (got.length === n) {
            break;
          }
        }

        return { ns: numbers(got) };
      } finally {
        await inbox.close();
      }
    },
    drive: async (d) => {
      await d.opened("inbox");
      await d.sendAll(
        "msg",
        upTo(n).map((i) => {
          return { n: i };
        }),
      );
    },
    expect: {
      output: { ns: upTo(n) },
      bodies: {},
      rows: ["inbox"],
      steps: n + 1,
    },
  };
};

const lookalikeStep: Flow = {
  name: "inbox-lookalike",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", source(h));
    const id = createHash("sha1").update("inbox").digest("hex");

    try {
      const fake = await h.step.run("fake", () => {
        h.ran("fake");

        return { data: { n: 99 }, inbox: id, src: [] };
      });
      const real = await inbox.next();

      return { fake: fake.data.n, real: (real.data as { n: number }).n };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.send("msg", { n: 1 });
  },
  expect: {
    output: { fake: 99, real: 1 },
    bodies: { fake: 1 },
    rows: ["fake", "inbox"],
    steps: 3,
  },
};

const twoSources: Flow = {
  name: "inbox-two-sources",
  run: async (h) => {
    const inbox = h.step.subscribe("inbox", [
      source(h),
      // Matches the same events as the first source, written differently.
      {
        event: h.event("msg"),
        if: `async.data.key == "${h.key}" && async.data.n > 0`,
      },
    ]);

    try {
      const got = [await inbox.next(), await inbox.next()];

      return { ns: numbers(got) };
    } finally {
      await inbox.close();
    }
  },
  drive: async (d) => {
    await d.opened("inbox");
    await d.sendAll("msg", [{ n: 1 }, { n: 2 }]);
  },
  expect: {
    output: { ns: [1, 2] },
    bodies: {},
    rows: ["inbox"],
    steps: 3,
  },
};

export const inboxUnread = flowScenario({
  id: "inbox-unread",
  owner: "sub-03-unread-and-redelivery",
  flows: [
    unreadMessages,
    loopOf(1),
    loopOf(10),
    loopOf(100),
    lookalikeStep,
    twoSources,
  ],
});
