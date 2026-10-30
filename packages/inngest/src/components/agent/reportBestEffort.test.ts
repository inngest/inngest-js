/**
 * @module
 * Tests that `report.status()`, `report.card()` and `report.begin()` are best
 * effort: they never block the caller and a failure never fails the run, while
 * `report.finish()` is awaited and surfaces its error.
 */
import { describe, expect, test, vi } from "vitest";
import { createReporter, defineChannel } from "./channels.ts";

const streamChannel = (
  append: (cards: unknown[]) => Promise<void>,
  stop?: () => Promise<void>,
) => {
  return defineChannel({
    post: async () => {},
    stream: {
      limits: { maxCards: 50, rollAt: 40, maxAgeMs: 60_000 },
      start: async () => {
        return "s";
      },
      append: async (_id, cards) => {
        await append(cards);
      },
      stop,
    },
  });
};

describe("best-effort reports", () => {
  test("a card write that fails is logged, its step completes, and the run goes on", async () => {
    const warn = vi.fn();
    const steps: string[] = [];
    const channel = streamChannel(async () => {
      throw new Error("message_not_found");
    });
    const report = createReporter(
      { main: channel },
      undefined,
      async (id, fn) => {
        steps.push(id);

        return fn();
      },
      undefined,
      { warn },
    );

    await report.card({ id: "a", title: "A" });
    await report.card({ id: "b", title: "B" });
    await expect(report.settled()).resolves.toBeUndefined();

    expect(steps).toEqual(["report:card:1:0:main", "report:card:2:0:main"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      kind: "card",
      destination: "main",
    });
  });

  test("the caller is not held up by the write step", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wrote: string[] = [];
    const channel = streamChannel(async (cards) => {
      wrote.push(String((cards[0] as { id: string }).id));
    });
    const report = createReporter(
      { main: channel },
      undefined,
      async (_, fn) => {
        await gate;

        return fn();
      },
    );

    // Resolves while the step is still waiting on `gate`.
    await report.card({ id: "a", title: "A" });
    await report.status("working");
    expect(wrote).toEqual([]);

    release();
    await report.settled();
    expect(wrote).toEqual([]);

    await report.card({ id: "b", title: "B" });
    await report.settled();
    expect(wrote).toEqual(["b"]);
  });

  test("a hanging write is cut off at the timeout and the run finishes", async () => {
    const warn = vi.fn();
    const channel = defineChannel({
      post: async () => {},
      status: () => {
        return new Promise<void>(() => {});
      },
    });
    const report = createReporter(
      { main: channel },
      undefined,
      async (_, fn) => {
        return fn();
      },
      undefined,
      { warn, writeTimeoutMs: 20 },
    );

    await report.status("working");
    await report.settled();
    await expect(report.finish({ text: "Done." })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ kind: "status" });
  });

  test("a status queued before a final report never lands after it", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const channel = defineChannel({
      post: async (message) => {
        order.push(`post:${message.text}`);
      },
      status: async (status) => {
        await gate;
        order.push(`status:${status}`);
      },
    });
    const report = createReporter(
      { main: channel },
      undefined,
      async (_, fn) => {
        return fn();
      },
    );

    await report.status("working");

    const final = report("The answer.");

    release();
    await final;
    expect(order).toEqual(["status:working", "post:The answer."]);
  });

  test("finish is awaited, queues after earlier writes, and surfaces its error", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const channel = streamChannel(
      async () => {
        order.push("append");
      },
      async () => {
        order.push("stop");

        throw new Error("cannot stop");
      },
    );
    const report = createReporter(
      { main: channel },
      undefined,
      async (id, fn) => {
        if (id === "report:card:2:0:main") {
          await gate;
        }

        return fn();
      },
    );

    await report.card({ id: "a", title: "A" });
    await report.card({ id: "b", title: "B" });

    const finished = report.finish({ text: "Done." });
    const outcome = expect(finished).rejects.toThrow("cannot stop");

    release();
    await outcome;
    expect(order).toEqual(["append", "stop"]);
  });
});
