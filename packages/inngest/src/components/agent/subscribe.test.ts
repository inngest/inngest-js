/**
 * @module
 * Tests for `step.subscribe()` over the in-memory inbox store.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { claimedTail, memoryInboxStore } from "./inbox.ts";
import { noRing, run } from "./test-helpers.ts";

const client = () => {
  return new Inngest({ id: testClientId });
};

const scoped = (key: string) => {
  return `${testClientId}:${key}`;
};

describe("step.subscribe", () => {
  test("delivers queued messages in order, one memoized step each", async () => {
    const store = memoryInboxStore();
    await store.append(scoped("t1"), "a");
    await store.append(scoped("t1"), { b: 1 });

    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const seen: unknown[] = [];

        for await (const message of step.subscribe("inbox", {
          key: "t1",
          store,
          maxRechecks: 1,
        })) {
          seen.push([message.seq, message.data]);
        }

        return seen;
      },
    );

    const { ran, output } = await run(fn, noRing);

    expect(output).toEqual([
      [1, "a"],
      [2, { b: 1 }],
    ]);
    expect(ran).toEqual([
      "inbox:read",
      "inbox:read",
      "inbox:read",
      "inbox:wait",
    ]);
    expect(await store.cursors(scoped("t1"))).toEqual({ head: 2, acked: 2 });
  });

  test("a ring on the doorbell wakes the reader to read again", async () => {
    const store = memoryInboxStore();

    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = step.subscribe("inbox", { key: "t1", store });

        return inbox.next();
      },
    );

    const { ran, output } = await run(fn, async (op) => {
      expect(op.opts).toMatchObject({
        signal: `inbox:${scoped("t1")}`,
        timeout: "5m",
        conflict: "replace",
      });
      await store.append(scoped("t1"), "late");

      return true;
    });

    expect(output).toEqual({ seq: 1, data: "late" });
    expect(ran).toEqual(["inbox:read", "inbox:wait", "inbox:read"]);
  });

  test("pending() reports messages without claiming them", async () => {
    const store = memoryInboxStore();
    await store.append(scoped("t1"), "a");

    const fn = client().createFunction(
      { id: "sub", triggers: [{ event: "sub/run" }] },
      async ({ step }) => {
        const inbox = step.subscribe("inbox", { key: "t1", store });
        const before = await inbox.pending();
        await inbox.next();

        return [before, await inbox.pending()];
      },
    );

    const { output } = await run(fn, noRing);

    expect(output).toEqual([true, false]);
  });
});

describe("memory inbox store", () => {
  test("claiming twice with one owner returns the same message", async () => {
    const store = memoryInboxStore();
    await store.append("k", 1);
    await store.append("k", 2);

    expect(await store.claim("k", "o1")).toEqual({ seq: 1, data: 1 });
    expect(await store.claim("k", "o1")).toEqual({ seq: 1, data: 1 });
    expect(await store.claim("k", "o2")).toEqual({ seq: 2, data: 2 });
    expect(await store.claim("k", "o3")).toBeNull();
  });
});

describe("memory inbox store peek", () => {
  test("peek shows the next message without claiming it", async () => {
    const store = memoryInboxStore();
    expect(await store.peek("k")).toBeNull();

    await store.append("k", "a");

    expect(await store.peek("k")).toEqual({ seq: 1, data: "a" });
    expect(await store.cursors("k")).toEqual({ head: 1, acked: 0 });
  });
});

describe("memory inbox store retention", () => {
  test("keeps only a tail of claimed messages", async () => {
    const store = memoryInboxStore();

    for (let i = 1; i <= claimedTail + 5; i++) {
      await store.append("k", i);
      await store.claim("k", `o${i}`);
    }

    // The last claimed messages are still there for a retried claim.
    expect(await store.claim("k", `o${claimedTail + 5}`)).toEqual({
      seq: claimedTail + 5,
      data: claimedTail + 5,
    });
    expect(await store.cursors("k")).toEqual({
      head: claimedTail + 5,
      acked: claimedTail + 5,
    });
  });
});
