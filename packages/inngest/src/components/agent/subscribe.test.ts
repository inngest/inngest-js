/**
 * @module
 * Tests for `step.subscribe()` against a fake executor.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { run } from "./test-helpers.ts";

const client = () => {
  return new Inngest({ id: testClientId });
};

const subscribeOpts = { event: "msg", if: "async.data.t == 't1'" };

describe("step.subscribe", () => {
  test("a message that is already saved is read without a step", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const seen: unknown[] = [];

        for (let n = 0; n < 2; n++) {
          const message = await inbox.next();
          seen.push([message?.seq, message?.data]);
        }

        return seen;
      },
    );

    const { ops, output } = await run(fn, { saved: ["a", { b: 1 }] });

    expect(output).toEqual([
      [1, "a"],
      [2, { b: 1 }],
    ]);
    // Open is the only step: the messages were in the state.
    expect(ops).toEqual([{ id: "inbox:open", mode: "open" }]);
  });

  test("next() blocks with one wait when no message has arrived, then reads it from the state", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);

        return (await inbox.next())?.data;
      },
    );

    const waiting = await run(fn);
    expect(waiting.waiting).toBe(true);
    expect(
      waiting.ops.map((op) => {
        return op.id;
      }),
    ).toEqual(["inbox:open", "inbox:1"]);

    const arrived = await run(fn, { incoming: ["late"] });
    expect(arrived.output).toBe("late");
    // The wait is not asked for again once the message is there.
    expect(
      arrived.ops.map((op) => {
        return op.mode;
      }),
    ).toEqual(["open", "park"]);
  });

  test("reads of one subscription run in call order, so one park is outstanding at a time", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const both = await Promise.all([inbox.next(), inbox.next()]);

        return both.map((m) => {
          return [m?.seq, m?.data];
        });
      },
    );

    const waiting = await run(fn);
    expect(waiting.waiting).toBe(true);
    expect(
      waiting.ops.map((op) => {
        return op.mode;
      }),
    ).toEqual(["open", "park"]);

    const arrived = await run(fn, { incoming: ["a", "b"] });
    expect(arrived.output).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
  });

  test("a message carries the name of its event", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next();
        const second = await inbox.poll();

        return [first?.name, second?.name];
      },
    );

    const { output } = await run(fn, {
      saved: [
        { name: "shop/order.created", data: { id: 1 } },
        { name: "shop/refund.created", data: { id: 2 } },
      ],
    });

    expect(output).toEqual(["shop/order.created", "shop/refund.created"]);
  });

  test("a message is the event flat with its seq: id, name, data, ts, user and seq", async () => {
    const event = {
      id: "evt-1",
      name: "shop/order.created",
      data: { total: 5 },
      ts: 7,
      user: { id: "u" },
      v: "2",
    };
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);

        return inbox.next();
      },
    );

    const { output } = await run(fn, { saved: [event] });

    expect(output).toEqual({ ...event, seq: 1 });
  });

  test("a memo from before messages were flat ({ seq, data: event }) still replays", async () => {
    const event = {
      id: "evt-1",
      name: "shop/order.created",
      data: { total: 5 },
      ts: 7,
      user: {},
    };
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next();
        const polled = await inbox.poll();
        const unread = await inbox.close();

        return [first, polled, unread];
      },
    );

    const { output } = await run(fn, {
      saved: [
        { seq: 1, data: event },
        event,
        { seq: 3, data: { ...event, id: "evt-3" } },
      ],
    });

    expect(output).toEqual([
      { ...event, seq: 1 },
      { ...event, seq: 2 },
      [{ ...event, id: "evt-3", seq: 3 }],
    ]);
  });

  test("close() ends the subscription and returns what was saved but not read; closing again does nothing", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next();
        const unread = await inbox.close();
        const again = await inbox.close();

        return [
          first?.data,
          unread.map((m) => {
            return m.data;
          }),
          again.length,
        ];
      },
    );

    const { ops, output } = await run(fn, { saved: ["a", "b", "c"] });

    expect(output).toEqual(["a", ["b", "c"], 0]);
    expect(
      ops.map((op) => {
        return op.mode;
      }),
    ).toEqual(["open", "close"]);
  });

  test("await using closes the subscription when the scope ends", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        {
          await using inbox = await step.subscribe("inbox", subscribeOpts);
          await inbox.next();
        }

        return "left";
      },
    );

    const { ops, output } = await run(fn, { saved: ["a"] });

    expect(output).toBe("left");
    expect(
      ops.map((op) => {
        return op.mode;
      }),
    ).toEqual(["open", "close"]);
  });

  test("a closed subscription reads no more", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        await inbox.close();

        return [await inbox.next(), await inbox.poll()];
      },
    );

    const { output } = await run(fn, { saved: [] });

    expect(output).toEqual([null, null]);
  });

  test("poll() is a step, so its answer is the same when the function replays", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.poll();
        const second = await inbox.poll();

        return [first?.data ?? null, second?.data ?? null];
      },
    );

    const { output, ops } = await run(fn, { saved: ["a"] });

    expect(output).toEqual(["a", null]);
    expect(
      ops.map((op) => {
        return op.id;
      }),
    ).toEqual(["inbox:open", "inbox:poll:1", "inbox:poll:2"]);
  });

  test("putBack returns a message before newer ones, without another op", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next();
        if (first) {
          inbox.putBack([first]);
        }

        return [(await inbox.next())?.seq, (await inbox.next())?.seq];
      },
    );

    const { output } = await run(fn, { saved: ["a", "b"] });

    expect(output).toEqual([1, 2]);
  });

  test("several events are one subscription: one open per event, one sequence of messages", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", {
          events: [{ event: "a" }, { event: "b" }],
        });

        return [(await inbox.next())?.data, (await inbox.next())?.data];
      },
    );

    const { ops, output } = await run(fn, { saved: ["from-b", "from-a"] });

    expect(output).toEqual(["from-b", "from-a"]);
    expect(ops).toEqual([
      { id: "inbox:0:open", mode: "open" },
      { id: "inbox:1:open", mode: "open" },
    ]);
  });

  test("an open for every event is the only step a subscription costs when the messages are there", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", {
          events: [{ event: "a" }, { event: "b" }],
        });
        const read: unknown[] = [];

        for (let n = 0; n < 5; n++) {
          read.push((await inbox.next())?.data);
        }

        return read;
      },
    );

    const { ops } = await run(fn, { saved: [1, 2, 3, 4, 5] });

    expect(
      ops.map((op) => {
        return op.mode;
      }),
    ).toEqual(["open", "open"]);
  });

  test("a read that was dropped still takes its message, in the first run and on replay alike", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        // Already settled, so it beats the read in every run.
        const slow = Promise.resolve("timeout");
        const winner = await Promise.race([inbox.next(), slow]);

        // A macrotask gap: the dropped read has settled by now if it can.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });

        const next = await inbox.next();

        return [winner, next?.data];
      },
    );

    // The dropped read parks; the second read waits behind it, not beside it.
    const waiting = await run(fn);
    expect(waiting.waiting).toBe(true);
    expect(
      waiting.ops.map((op) => {
        return op.mode;
      }),
    ).toEqual(["open", "park"]);

    // On replay the dropped read finds "a" in the state and takes it; the next
    // read gets "b". The same answer however the timing of the first run went.
    const arrived = await run(fn, { incoming: ["a", "b"] });
    expect(arrived.output).toEqual(["timeout", "b"]);
  });
});
