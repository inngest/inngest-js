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
  test("opens once, then each message is a numbered, acked step", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const seen: unknown[] = [];

        await inbox.close();
        for await (const message of inbox) {
          seen.push([message.seq, message.data]);
        }

        return seen;
      },
    );

    const { ops, acked, output } = await run(fn, { saved: ["a", { b: 1 }] });

    expect(output).toEqual([
      [1, "a"],
      [2, { b: 1 }],
    ]);
    expect(ops).toEqual([
      { id: "inbox:open", mode: "open" },
      { id: "inbox:close", mode: "close" },
      { id: "inbox:1", mode: "next", seq: 1 },
      { id: "inbox:ack:1", mode: "ack", seq: 1 },
      { id: "inbox:2", mode: "next", seq: 2 },
      { id: "inbox:ack:2", mode: "ack", seq: 2 },
    ]);
    expect(acked).toEqual([1, 2]);
  });

  test("next() waits when no message has arrived, then continues when it does", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);

        return (await inbox.next())?.data;
      },
    );

    const waiting = await run(fn);
    expect(waiting.waiting).toBe(true);

    const arrived = await run(fn, { incoming: ["late"] });
    expect(arrived.output).toBe("late");
  });

  test("poll() reads a message that has arrived and never waits", async () => {
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
    expect(ops.map((op) => op.id)).toEqual([
      "inbox:open",
      "inbox:poll:1",
      "inbox:ack:1",
      "inbox:poll:2",
    ]);
  });

  test("putBack returns a message before newer ones, without another op", async () => {
    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = await step.subscribe("inbox", subscribeOpts);
        const first = await inbox.next();
        if (first) {
          inbox.putBack(first);
        }

        return [(await inbox.next())?.seq, (await inbox.next())?.seq];
      },
    );

    const { output } = await run(fn, { saved: ["a", "b"] });

    expect(output).toEqual([1, 2]);
  });
});
