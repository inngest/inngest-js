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

const ids = (ops: { id: string }[]) => {
  return ops.map((op) => {
    return op.id;
  });
};

const modes = (ops: { mode: string }[]) => {
  return ops.map((op) => {
    return op.mode;
  });
};

describe("step.subscribe", () => {
  test("open is one step; messages already saved are read with no step", async () => {
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
    expect(ops).toEqual([{ id: "inbox:open", mode: "open", streams: 1 }]);
  });

  test("next() with nothing saved is one next op; the message is read in process once it is in the state", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);

        return (await inbox.next())?.data;
      },
    );

    const waiting = await run(fn);
    expect(waiting.waiting).toBe(true);
    expect(ids(waiting.ops)).toEqual(["inbox:open", "inbox:0:next:1"]);

    const arrived = await run(fn, { incoming: ["late"] });
    expect(arrived.output).toBe("late");
    expect(modes(arrived.ops)).toEqual(["open", "next"]);
  });

  test("buffered messages are flushed by the next op, all of them, and read in arrival order", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next();
        const second = await inbox.next();
        const third = await inbox.next();

        return [first?.data, second?.data, third?.data];
      },
    );

    const { ops, output } = await run(fn, { buffered: ["a", "b", "c"] });

    expect(output).toEqual(["a", "b", "c"]);
    expect(modes(ops)).toEqual(["open", "next"]);
  });

  test("a read made inside a step id prefix keeps the step ids the executor expects", async () => {
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

    expect(ids(waiting.ops)).toEqual(["inbox:open", "inbox:0:next:1"]);
  });

  test("a view has one next outstanding: a second call returns the same promise", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = inbox.next();
        const second = inbox.next();

        return [first === second, (await first)?.data];
      },
    );

    const waiting = await run(fn);
    expect(modes(waiting.ops)).toEqual(["open", "next"]);

    const arrived = await run(fn, { incoming: ["a"] });
    expect(arrived.output).toEqual([true, "a"]);
  });

  test("a next that times out is recorded under its own id and reads undefined on a replay", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const timedOut = await inbox.next({ timeout: "1m" });
        const later = await inbox.next();

        return [timedOut, later?.data];
      },
    );

    const { ops, output } = await run(fn, {
      timeouts: 1,
      incoming: ["after"],
    });

    expect(output).toEqual([undefined, "after"]);
    expect(ids(ops)).toEqual([
      "inbox:open",
      "inbox:0:next:1",
      "inbox:0:next:2",
    ]);
  });

  test("a timeout wins over a message that arrived after it", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);

        return (await inbox.next({ timeout: "1m" })) === undefined;
      },
    );

    const { output } = await run(fn, {
      timeouts: 1,
      incoming: ["late"],
    });

    expect(output).toBe(true);
  });

  test("next({ timeout: 0 }) flushes, never waits, and reads what was there", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next({ timeout: 0 });
        const second = await inbox.next({ timeout: 0 });

        return [first?.data, second];
      },
    );

    const { ops, output } = await run(fn, { buffered: ["a"] });

    expect(output).toEqual(["a", undefined]);
    expect(modes(ops)).toEqual(["open", "all", "all"]);
  });

  test("all() is one flush op and returns every unread message, put-back ones first", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next();

        if (first) {
          inbox.putBack([first]);
        }

        const rest = await inbox.all();

        return rest.map((message) => {
          return message.data;
        });
      },
    );

    const { ops, output } = await run(fn, {
      saved: ["a"],
      buffered: ["b", "c"],
    });

    expect(output).toEqual(["a", "b", "c"]);
    expect(modes(ops)).toEqual(["open", "all"]);
  });

  test("all() reads only up to the total its op recorded", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const taken = await inbox.all();

        return taken.length;
      },
    );

    // A replay's state holds messages that arrived after the original all(): the
    // memoized answer bounds what it returns.
    const { output } = await run(fn, {
      memos: { "inbox:0:all:1": { total: 1 } },
      saved: ["a", "b", "c"],
    });

    expect(output).toBe(1);
  });

  test("an inbox closed by a limit ends after the messages saved before it", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next();
        const end = await inbox.next();

        return [first?.data, end];
      },
    );

    const { ops, output } = await run(fn, { saved: ["a"], closed: true });

    expect(output).toEqual(["a", null]);
    expect(modes(ops)).toEqual(["open"]);
  });

  test("a message carries the name of its event, its seq and its stream", async () => {
    const event = {
      id: "evt-1",
      name: "shop/order.created",
      data: { total: 5 },
      ts: 7,
      user: { id: "u" },
      v: "2",
      stream: 0,
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

  test("close() is one op, stops every source, and returns the unread messages", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", {
          events: [{ event: "a" }, { event: "b" }],
        });
        const first = await inbox.next();
        const rest = await inbox.close();
        const again = await inbox.close();

        return [first?.data, rest.map((m) => m.data), again];
      },
    );

    const { ops, output } = await run(fn, {
      saved: ["x"],
      buffered: ["y", "z"],
    });

    expect(output).toEqual(["x", ["y", "z"], []]);
    expect(ops).toEqual([
      { id: "inbox:open", mode: "open", streams: 2 },
      { id: "inbox:close", mode: "close", streams: 2 },
    ]);
  });

  test("after close() next() is null once the saved messages are read", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        await inbox.close();

        return inbox.next();
      },
    );

    const { output } = await run(fn);

    expect(output).toBeNull();
  });

  test("of(type) reads the messages of one event with a cursor of its own", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", {
          events: [{ event: "a" }, { event: "b" }],
        });
        const b = inbox.of("b");
        const fromB = await b.next();
        const first = await inbox.next();

        return [fromB?.data, first?.data, (await b.all()).length];
      },
    );

    const { output } = await run(fn, {
      saved: [
        { id: "1", name: "a", data: "a1", ts: 0, user: {} },
        { id: "2", name: "b", data: "b1", ts: 0, user: {} },
      ],
    });

    expect(output).toEqual(["b1", "a1", 0]);
  });

  test("of(type).close() stops the sources of that event", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", {
          events: [{ event: "a" }, { event: "b" }, { event: "b", if: "x" }],
        });

        await inbox.of("b").close();
        await inbox.of("b").close();

        return "done";
      },
    );

    const { ops } = await run(fn);

    expect(ops).toEqual([
      { id: "inbox:open", mode: "open", streams: 3 },
      { id: "inbox:1:stop", mode: "stop", streams: 2 },
    ]);
  });

  test("listen() opens its sources in one op and returns a view of them alone", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        await using ci = await inbox.listen([
          { event: "ci/a" },
          { event: "ci/b", if: "async.data.pr == 1" },
        ]);
        const message = await ci.next();

        return message?.data;
      },
    );

    const { ops, output } = await run(fn, {
      saved: [
        { id: "1", name: "msg", data: "plain", ts: 0, user: {}, stream: 0 },
        { id: "2", name: "ci/b", data: "ci", ts: 0, user: {}, stream: 2 },
      ],
    });

    expect(output).toBe("ci");
    expect(ops).toEqual([
      { id: "inbox:open", mode: "open", streams: 1 },
      { id: "inbox:1:listen", mode: "open", streams: 2 },
      { id: "inbox:1:stop", mode: "stop", streams: 2 },
    ]);
  });

  test("ready() is true when a message is saved and unread, held, or the inbox ended", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const before = inbox.ready();
        const first = await inbox.next();
        const after = inbox.ready();

        if (first) {
          inbox.putBack([first]);
        }

        return [before, after, inbox.ready()];
      },
    );

    const { output } = await run(fn, { saved: ["a"] });

    expect(output).toEqual([true, false, true]);
  });

  test("a message that is not an event is an error", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);

        return inbox.next().catch((error: Error) => {
          return error.message;
        });
      },
    );

    const { output } = await run(fn, { saved: [{ data: 1, seq: 9 }] });

    expect(output).toContain("is not an event");
  });

  test("an inbox with no sources is allowed and still opens", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.inbox("inbox");

        return inbox.ready();
      },
    );

    const { ops } = await run(fn);

    expect(ops).toEqual([{ id: "inbox:open", mode: "open", streams: 0 }]);
  });

  test("step.subscribe() with no event throws", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        try {
          await step.subscribe("inbox", { events: [] });
        } catch (error) {
          return (error as Error).message;
        }

        return "opened";
      },
    );

    const { output } = await run(fn);

    expect(output).toContain("needs at least one event");
  });
});
