/**
 * @module
 * Tests for a subscription over several events, against a fake executor that
 * saves messages per stream and answers each op like the real one.
 */

import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { openSubscription, type SubscribeOp } from "./subscribe.ts";

/**
 * A fake executor. `arrive(stream, data)` saves a message to a stream; a
 * `next` op resolves once its message is saved, a `poll` answers at once.
 */
const fakeExecutor = () => {
  const saved: unknown[][] = [[], [], []];
  const waiters: (() => void)[] = [];
  const log: string[] = [];

  const op: SubscribeOp = async (stepId, mode, seq, stream) => {
    log.push(`${stepId}`);

    if (mode === "open") {
      return { opened: true };
    }

    if (mode === "ack") {
      return true;
    }

    if (mode === "close") {
      return { count: (saved[stream] as unknown[]).length };
    }

    const messages = saved[stream] as unknown[];
    if (mode === "poll") {
      return messages[(seq as number) - 1] ?? null;
    }

    while (messages.length < (seq as number)) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }

    return messages[(seq as number) - 1];
  };

  return {
    op,
    log,
    arrive(stream: number, data: unknown) {
      (saved[stream] as unknown[]).push(data);
      for (const wake of waiters.splice(0)) {
        wake();
      }
    },
  };
};

const opts = { events: [{ event: "a" }, { event: "b" }] };

describe("subscription over several events", () => {
  test("hands out messages from every stream in arrival order, none lost, none repeated", async () => {
    const exec = fakeExecutor();
    const sub = await openSubscription<string>(exec.op, "inbox", opts);
    const got: string[] = [];

    exec.arrive(1, "b1");
    got.push((await sub.next())?.data as string);
    exec.arrive(0, "a1");
    exec.arrive(1, "b2");
    exec.arrive(0, "a2");
    for (let i = 0; i < 3; i++) {
      got.push((await sub.next())?.data as string);
    }

    expect(got[0]).toBe("b1");
    expect([...got].sort()).toEqual(["a1", "a2", "b1", "b2"]);
    expect(got.indexOf("a1")).toBeLessThan(got.indexOf("a2"));
    expect(got.indexOf("b1")).toBeLessThan(got.indexOf("b2"));
  });

  test("a stream that lost a race keeps its wait: the same step is reused", async () => {
    const exec = fakeExecutor();
    const sub = await openSubscription<string>(exec.op, "inbox", opts);

    exec.arrive(0, "a1");
    await sub.next();
    exec.arrive(0, "a2");
    await sub.next();

    const waitsOnB = exec.log.filter((id) => {
      return id === "inbox:1:1";
    });
    expect(waitsOnB).toHaveLength(1);
  });

  test("messages carry a merged seq and acks reach each stream in its own order", async () => {
    const exec = fakeExecutor();
    const sub = await openSubscription<string>(exec.op, "inbox", opts);
    exec.arrive(0, "a1");
    exec.arrive(1, "b1");
    exec.arrive(0, "a2");

    const messages = [await sub.next(), await sub.next(), await sub.next()];
    expect(
      messages.map((m) => {
        return m?.seq;
      }),
    ).toEqual([1, 2, 3]);

    for (const message of messages) {
      await sub.ack(message as never);
    }

    const acks = exec.log.filter((id) => {
      return id.includes(":ack:");
    });
    expect(acks.filter((id) => id.startsWith("inbox:0:"))).toEqual([
      "inbox:0:ack:1",
      "inbox:0:ack:2",
    ]);
    expect(acks.filter((id) => id.startsWith("inbox:1:"))).toEqual([
      "inbox:1:ack:1",
    ]);
  });

  test("poll takes what has arrived on any stream and nothing otherwise", async () => {
    const exec = fakeExecutor();
    const sub = await openSubscription<string>(exec.op, "inbox", opts);

    expect(await sub.poll()).toBeNull();
    exec.arrive(1, "b1");
    expect((await sub.poll())?.data).toBe("b1");
    expect(await sub.poll()).toBeNull();
  });

  test("a poll that takes the message a pending wait was for does not deliver it twice", async () => {
    const exec = fakeExecutor();
    const sub = await openSubscription<string>(exec.op, "inbox", opts);

    exec.arrive(0, "a1");
    expect((await sub.next())?.data).toBe("a1");
    // Stream 1 now has a wait for its message 1; poll takes that message.
    exec.arrive(1, "b1");
    expect((await sub.poll())?.data).toBe("b1");
    exec.arrive(0, "a2");
    expect((await sub.next())?.data).toBe("a2");
  });

  test("close drains every stream and then ends the iteration", async () => {
    const exec = fakeExecutor();
    const sub = await openSubscription<string>(exec.op, "inbox", opts);
    exec.arrive(0, "a1");
    exec.arrive(1, "b1");

    expect(await sub.close()).toBe(2);
    const got = [(await sub.next())?.data, (await sub.next())?.data];
    expect([...got].sort()).toEqual(["a1", "b1"]);
    expect(await sub.next()).toBeNull();
  });

  test("a single event keeps the plain step IDs", async () => {
    const exec = fakeExecutor();
    const sub = await openSubscription<string>(exec.op, "inbox", {
      event: "a",
    });
    exec.arrive(0, "a1");
    await sub.next();

    expect(exec.log).toEqual(["inbox:open", "inbox:1"]);
  });
});

describe("ack", () => {
  test("a numbered message without a source is an error, the put-back trigger is not", async () => {
    const exec = fakeExecutor();
    const sub = await openSubscription<string>(exec.op, "inbox", opts);

    await expect(sub.ack({ seq: 3, data: "x" })).rejects.toThrow(/no source/);
    await expect(sub.ack({ seq: 0, data: "trigger" })).resolves.toBeUndefined();
  });
});

describe("a function that stops waiting on a subscription stream", () => {
  test("is done when it returns: the abandoned wait is not scheduled", async () => {
    const fn = new Inngest({ id: testClientId }).createFunction(
      { id: "abandon", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const subscribe = (
          step as unknown as {
            "~subscribeOp": (
              id: string,
              opts: Record<string, unknown>,
            ) => Promise<unknown>;
          }
        )["~subscribeOp"];

        // The loser of a race between streams: started, never awaited again.
        void subscribe("inbox:0:1", {
          event: "msg",
          subscribe: { key: "inbox:0", mode: "next", seq: 1 },
        });

        return "done";
      },
    );

    const result = await runFnWithStack(
      fn,
      {},
      { event: { name: "sub/run", data: {} } },
    );

    expect(result.type).toBe("function-resolved");
  });
});
