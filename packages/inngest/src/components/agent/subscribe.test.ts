/**
 * @module
 * Tests for `step.subscribe()` against a fake executor.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { withStepIdPrefix } from "../InngestStepTools.ts";
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
    expect(ops).toEqual([{ id: "inbox:0:open", mode: "open" }]);
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
    ).toEqual(["inbox:0:open", "inbox:1"]);

    const arrived = await run(fn, { incoming: ["late"] });
    expect(arrived.output).toBe("late");
    // The wait is not asked for again once the message is there.
    expect(
      arrived.ops.map((op) => {
        return op.mode;
      }),
    ).toEqual(["open", "wait"]);
  });

  test("a read made inside a step id prefix (a tool group) keeps the step ids the executor expects", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);

        return withStepIdPrefix("tool:", () => {
          return inbox.next();
        });
      },
    );

    const waiting = await run(fn);

    expect(
      waiting.ops.map((op) => {
        return op.id;
      }),
    ).toEqual(["inbox:0:open", "inbox:1"]);
  });

  test("reads of one subscription run in call order, so one wait is outstanding at a time", async () => {
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
    ).toEqual(["open", "wait"]);

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
        const second = await inbox.next({ timeout: 0 });

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
        const polled = await inbox.next({ timeout: 0 });
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

  test("a read waiting when the subscription closes is the end of the subscription", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);

        return inbox.next();
      },
    );

    const closed = await run(fn, { closeWhenBlocked: true });
    expect(closed.output).toBeNull();

    // Messages saved before the close are still read first.
    const drained = await run(fn, { saved: ["a"], closeWhenBlocked: true });
    expect((drained.output as { data: unknown }).data).toBe("a");
  });

  test("next({ timeout }) returns undefined when nothing arrives, and a later read waits again as a new step", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next({ timeout: "1s" });
        const second = await inbox.next({ timeout: "1s" });
        const third = await inbox.next();

        return [first, second, third?.data];
      },
    );

    const { ops, output } = await run(fn, {
      incoming: ["late"],
      timeouts: 2,
    });

    expect(output).toEqual([undefined, undefined, "late"]);
    // Three waits for message 1, each its own step.
    expect(
      new Set(
        ops
          .filter((op) => {
            return op.mode === "wait";
          })
          .map((op) => {
            return op.id;
          }),
      ).size,
    ).toBe(3);
  });

  test("a timeout that was recorded stays a timeout on replay, even though the message has arrived since", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next({ timeout: "1s" });
        const second = await inbox.next();

        return [first, second?.data];
      },
    );

    const { output } = await run(fn, { incoming: ["late"], timeouts: 1 });

    expect(output).toEqual([undefined, "late"]);
  });

  test("listen() adds a source to the same ordered sequence, and stop() removes it", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next();
        const listener = await inbox.listen({
          event: "other",
          if: "async.data.x == 1",
        });
        const second = await inbox.next();

        await listener.stop();
        await listener.stop();

        return [first?.data, second?.data];
      },
    );

    const { ops, output } = await run(fn, {
      saved: ["a"],
      incoming: ["b"],
    });

    expect(output).toEqual(["a", "b"]);
    // The added source is stream 1, and stopping twice is one stop.
    expect(
      ops.map((op) => {
        return [op.mode, op.stream ?? 0, op.id];
      }),
    ).toEqual([
      ["open", 0, "inbox:0:open"],
      ["open", 1, "inbox:1:open"],
      ["wait", 0, "inbox:2"],
      ["stop", 1, "inbox:1:stop"],
    ]);
  });

  test("step ids carry the stream number, and a run that began without it keeps its memos", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);

        return (await inbox.close()).length;
      },
    );

    const fresh = await run(fn);
    expect(
      fresh.ops.map((op) => {
        return op.id;
      }),
    ).toEqual(["inbox:0:open", "inbox:0:close"]);

    // Memos from before: the first source's steps were `inbox:open` and
    // `inbox:close`. The function replays against them, no step is asked again.
    const legacy = await run(fn, {
      memos: {
        "inbox:open": { opened: true },
        "inbox:close": { count: 0 },
      },
    });
    expect(legacy.ops).toEqual([]);
    expect(legacy.output).toBe(0);
  });

  test("an inbox with no source left is still closed by one op, and listening after close throws", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.inbox("box");
        const listener = await inbox.listen({ event: "other", if: "true" });

        await listener.stop();
        await inbox.close();

        const late = await inbox.listen({ event: "other", if: "true" }).then(
          () => "added",
          (error: Error) => error.message,
        );

        return late;
      },
    );

    const { ops, output } = await run(fn, { key: "box" });

    expect(String(output)).toContain("listen() on a closed inbox");
    expect(
      ops.map((op) => {
        return op.mode;
      }),
    ).toEqual(["open", "stop", "close"]);
  });

  test("current() returns every message so far without moving the cursor", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next();
        const all = await inbox.current();
        const second = await inbox.next();
        const pending = await inbox.unread();

        return [
          first?.data,
          all.map((m) => {
            return m.data;
          }),
          second?.data,
          pending.map((m) => {
            return m.data;
          }),
        ];
      },
    );

    const { output } = await run(fn, { saved: ["a", "b", "c"] });

    expect(output).toEqual(["a", ["a", "b", "c"], "b", ["c"]]);
  });

  test("an inbox starts with no source and takes them with listen()", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.inbox("box");

        await inbox.listen({ event: "other", if: "async.data.x == 1" });

        return (await inbox.next())?.data;
      },
    );

    const { ops, output } = await run(fn, {
      key: "box",
      incoming: ["late"],
    });

    expect(output).toBe("late");
    expect(
      ops.map((op) => {
        return op.id;
      }),
    ).toEqual(["box:0:open", "box:1"]);
  });

  describe("views", () => {
    const mention = (n: number) => {
      return {
        id: `m${n}`,
        name: "chat/mention",
        data: { n },
        ts: n,
        user: {},
      };
    };
    const review = (n: number) => {
      return { id: `r${n}`, name: "pr/review", data: { n }, ts: n, user: {} };
    };

    test("a view is a cursor of its own: it hides nothing from the inbox or other views, and reads by arrival order", async () => {
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          const reviews = inbox.of("pr/review");
          const mentions = inbox.of("chat/mention");

          const r1 = await reviews.next();
          const m1 = await inbox.next();
          const r2 = await reviews.next();
          const m2 = await inbox.next();
          const mention1 = await mentions.next();

          return [r1, m1, r2, m2, mention1].map((m) => {
            return [m?.seq, m?.name];
          });
        },
      );

      // Stack: seq1 mention, seq2 review, seq3 mention, seq4 review.
      const { output } = await run(fn, {
        saved: [mention(1), review(2), mention(3), review(4)],
      });

      expect(output).toEqual([
        [2, "pr/review"],
        [1, "chat/mention"],
        [4, "pr/review"],
        [2, "pr/review"],
        [1, "chat/mention"],
      ]);
    });

    test("a view waits for its kind: it waits at the next message and looks again", async () => {
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          const reviews = inbox.of("pr/review");
          const got = await reviews.next();

          return [got?.seq, got?.data];
        },
      );

      // Two mentions arrive before the review the view waits for.
      const { output, ops } = await run(fn, {
        incoming: [mention(1), mention(2), review(3)],
      });

      expect(output).toEqual([3, { n: 3 }]);
      expect(
        ops
          .filter((op) => {
            return op.mode === "wait";
          })
          .map((op) => {
            return op.id;
          }),
      ).toEqual(["inbox:v1:1", "inbox:v1:2", "inbox:v1:3"]);
    });

    test("unread() takes what is after the cursor, current() lists all, and neither waits", async () => {
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          const reviews = inbox.of("pr/review");
          const first = await reviews.next();
          const all = await reviews.current();
          const rest = await reviews.unread();
          const none = await reviews.unread();
          const poll = await reviews.next({ timeout: 0 });

          return [
            first?.seq,
            all.map((m) => {
              return m.seq;
            }),
            rest.map((m) => {
              return m.seq;
            }),
            none.length,
            poll,
          ];
        },
      );

      const { output } = await run(fn, {
        saved: [review(1), mention(2), review(3), review(4)],
      });

      expect(output).toEqual([1, [1, 3, 4], [3, 4], 0, undefined]);
    });

    test("the reads are the same whatever the arrival timing", async () => {
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          const reviews = inbox.of("pr/review");
          const mentions = inbox.of("chat/mention");
          const r = await reviews.next();
          const m = await mentions.next();
          const r2 = await reviews.next();

          return [r?.seq, m?.seq, r2?.seq];
        },
      );
      const all = [mention(1), review(2), mention(3), review(4)];

      const together = await run(fn, { saved: all });
      const trickled = await run(fn, { incoming: all });
      const split = await run(fn, {
        saved: all.slice(0, 2),
        incoming: all.slice(2),
      });

      expect(together.output).toEqual([2, 1, 4]);
      expect(trickled.output).toEqual([2, 1, 4]);
      expect(split.output).toEqual([2, 1, 4]);
    });

    test("a view's timeout still applies after a message of another kind wakes it", async () => {
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          const reviews = inbox.of("pr/review");

          return String(await reviews.next({ timeout: "1s" }));
        },
      );
      const timeouts: unknown[] = [];

      // A mention runs the function again; the view looks again and waits again.
      const { waiting } = await run(fn, {
        incoming: [mention(1)],
        onOp: (op) => {
          if (String(op.op) === "Sleep") {
            timeouts.push(op.name);
          }
        },
      });

      expect(waiting).toBe(true);
      expect(timeouts).toEqual(["1s", "1s"]);
    });

    test("a timeout of a view stays a timeout on replay, though a match has arrived since", async () => {
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          const reviews = inbox.of("pr/review");
          const first = await reviews.next({ timeout: "1s" });
          const second = await reviews.next();

          return [first, second?.seq];
        },
      );

      const { output } = await run(fn, {
        incoming: [review(1)],
        timeouts: 1,
      });

      expect(output).toEqual([undefined, 1]);
    });

    test("msg.is() narrows by event name and is not a field of the message", async () => {
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          const a = await inbox.next();
          const b = await inbox.next();

          return [
            a?.is("chat/mention"),
            a?.is("pr/review"),
            b?.is("pr/review"),
            Object.keys(a ?? {}).includes("is"),
          ];
        },
      );

      const { output } = await run(fn, { saved: [mention(1), review(2)] });

      expect(output).toEqual([true, false, true, false]);
    });
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

        return [await inbox.next(), await inbox.next({ timeout: 0 })];
      },
    );

    const { output } = await run(fn, { saved: [] });

    expect(output).toEqual([null, null]);
  });

  test("next({ timeout: 0 }) is a step, so its answer is the same when the function replays", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next({ timeout: 0 });
        const second = await inbox.next({ timeout: 0 });

        return [first?.data ?? null, second?.data ?? null];
      },
    );

    const { output, ops } = await run(fn, { saved: ["a"] });

    expect(output).toEqual(["a", null]);
    expect(
      ops.map((op) => {
        return op.id;
      }),
    ).toEqual(["inbox:0:open", "inbox:poll:1", "inbox:poll:2"]);
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
      { id: "inbox:1:open", mode: "open", stream: 1 },
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

    // The dropped read waits; the second read waits behind it, not beside it.
    const waiting = await run(fn);
    expect(waiting.waiting).toBe(true);
    expect(
      waiting.ops.map((op) => {
        return op.mode;
      }),
    ).toEqual(["open", "wait"]);

    // On replay the dropped read finds "a" in the state and takes it; the next
    // read gets "b". The same answer however the timing of the first run went.
    const arrived = await run(fn, { incoming: ["a", "b"] });
    expect(arrived.output).toEqual(["timeout", "b"]);
  });

  describe("a read that waits ends its request, and a message runs the function again", () => {
    test("a message that arrives before the timeout returns it, and the pending timer is not waited for", async () => {
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          const first = await inbox.next({ timeout: "1h" });
          const second = await inbox.next();

          return [first?.data, second?.data];
        },
      );

      const { output, ops } = await run(fn, { incoming: ["a", "b"] });

      expect(output).toEqual(["a", "b"]);
      expect(
        ops.map((op) => {
          return [op.mode, op.timeout];
        }),
      ).toEqual([
        ["open", undefined],
        ["wait", "1h"],
        ["wait", undefined],
      ]);
    });

    test("a step running beside a waiting read is planned, never run in the request that found it", async () => {
      let ran = 0;
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          await step.run("work", () => {
            ran++;

            return "done";
          });

          return (await inbox.next())?.data;
        },
      );

      const { output, planned } = await run(fn, { incoming: ["m"] });

      expect(output).toBe("m");
      expect(planned).toEqual(["work"]);
      expect(ran).toBe(1);
    });

    test("a step beside a waiting read finishes, and the read still gets its message", async () => {
      let ran = 0;
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          const [work, message] = await Promise.all([
            step.run("work", () => {
              ran++;

              return "done";
            }),
            inbox.next(),
          ]);

          return [work, message?.data];
        },
      );

      const { output, waiting } = await run(fn, { incoming: ["m"] });

      expect(waiting).toBe(false);
      expect(output).toEqual(["done", "m"]);
      expect(ran).toBe(1);
    });

    test("a read that is never awaited does not hold the function", async () => {
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          void inbox.next();
          await step.run("work", () => {
            return "done";
          });

          return "finished";
        },
      );

      const { output, waiting } = await run(fn);

      expect(waiting).toBe(false);
      expect(output).toBe("finished");
    });

    test("two views waiting at once each get their own kind from one message sequence", async () => {
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);
          const a = inbox.of("a/event");
          const b = inbox.of("b/event");
          const [first, second] = await Promise.all([a.next(), b.next()]);

          return [first?.seq, second?.seq];
        },
      );
      const named = (name: string, n: number) => {
        return { id: `evt-${n}`, name, data: { n }, ts: 0, user: {} };
      };

      // b arrives first, then a: each view skips what is not its kind.
      const { output, waiting } = await run(fn, {
        incoming: [named("b/event", 1), named("a/event", 2)],
      });

      expect(waiting).toBe(false);
      expect(output).toEqual([2, 1]);
    });

    test("a limit close while a read waits ends the read after the messages already saved", async () => {
      const fn = client().createFunction(
        { id: "sub", triggers: [{ event: "sub/run" }] },
        async ({ step }) => {
          const inbox = await step.subscribe("inbox", subscribeOpts);

          return [(await inbox.next())?.data, await inbox.next()];
        },
      );

      const { output } = await run(fn, {
        saved: ["only"],
        closeWhenBlocked: true,
      });

      expect(output).toEqual(["only", null]);
    });
  });
});
