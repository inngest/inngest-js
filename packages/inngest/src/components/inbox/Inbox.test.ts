/**
 * @module
 * Tests for closing an `Inbox` against fake dependencies: what `close()` sends
 * the executor, what a closed reader returns, and `await using`.
 */
import { Inbox, type InboxDeps } from "./Inbox.ts";

const fakeDeps = (unread: string[]) => {
  const closes: unknown[] = [];

  const deps: InboxDeps = {
    sources: [{ event: "msg" }],
    id: "inbox",
    inbox: "inbox",
    open: async () => {
      return { pauses: ["p1"] };
    },
    waitId: (op) => {
      return `hash:${op}`;
    },
    wait: () => {
      return new Promise(() => {
        return undefined;
      });
    },
    read: () => {
      return { found: "nothing" };
    },
    unread: () => {
      return unread;
    },
    message: (id) => {
      return { name: "msg", data: { id } };
    },
    batch: async () => {
      return { seen: "inbox", ids: [] };
    },
    answered: () => {
      return false;
    },
    report: () => {
      return undefined;
    },
    skip: async () => {
      return undefined;
    },
    place: async () => {
      return undefined;
    },
    lastSeen: () => {
      return "inbox";
    },
    closed: () => {
      return false;
    },
    close: async (op, closing) => {
      closes.push({ op, closing });

      return closing.ids;
    },
  };

  return { deps, closes };
};

describe("closing an inbox", () => {
  test("close() sends the unread ids and the source pauses, and returns the unread messages", async () => {
    const { deps, closes } = fakeDeps(["m1", "m2"]);
    const inbox = new Inbox(deps);

    const unread = await inbox.close();

    expect(closes).toEqual([
      {
        op: "inbox:close",
        closing: {
          inbox: "inbox",
          ids: ["m1", "m2"],
          pauses: [{ id: "p1", event: "msg" }],
          waits: [],
          rows: ["inbox"],
        },
      },
    ]);
    expect(unread).toEqual([
      { name: "msg", data: { id: "m1" } },
      { name: "msg", data: { id: "m2" } },
    ]);
    expect(inbox.closed).toBe(true);
  });

  test("a closed reader reads nothing and sends no op", async () => {
    const { deps } = fakeDeps(["m1"]);
    const inbox = new Inbox(deps);
    await inbox.close();

    expect(await inbox.next()).toBeUndefined();
    expect(await inbox.nextBatch()).toBeUndefined();
    expect(await inbox.drain()).toEqual([]);

    const seen: unknown[] = [];
    for await (const message of inbox) {
      seen.push(message);
    }
    expect(seen).toEqual([]);
  });

  test("a read waiting under a closed reader is named by the close and ends", async () => {
    const { deps, closes } = fakeDeps([]);
    const inbox = new Inbox(deps);

    const waiting = inbox.next();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    await inbox.close();

    expect(closes).toMatchObject([{ closing: { waits: ["hash:inbox:next"] } }]);

    // The run is replayed once the close is recorded: the read finds nothing
    // and the state holds the close.
    const replayed = fakeDeps([]);
    replayed.deps.closed = (op) => {
      return op === "inbox:close";
    };
    const again = new Inbox(replayed.deps);

    const ending = again.next();
    await again.close();

    expect(await ending).toBeUndefined();
    expect(waiting).toBeInstanceOf(Promise);
  });

  test("closing a reader closes the views under it", async () => {
    const { deps } = fakeDeps(["m1"]);
    const inbox = new Inbox(deps);
    const view = inbox.of("msg");

    await inbox.close();

    expect(view.closed).toBe(true);
    expect(await view.next()).toBeUndefined();
    expect((await view.close()).length).toBe(1);
  });

  test("await using closes at the end of the block, once", async () => {
    const { deps, closes } = fakeDeps([]);

    {
      await using inbox = new Inbox(deps);
      expect(inbox.closed).toBe(false);
    }

    expect(closes).toHaveLength(1);
  });
});

describe("batch reads", () => {
  const withBatch = (
    unread: string[],
    answer: unknown,
    seen: unknown[] = [],
  ) => {
    const { deps } = fakeDeps(unread);
    deps.batch = async (op, read) => {
      seen.push({ op, ...read });

      return answer;
    };
    deps.unread = (_inbox, _taken, _want, upTo) => {
      // The state as far as the step the answer names: the first two messages.
      return upTo === undefined ? unread : unread.slice(0, 2);
    };

    return new Inbox(deps);
  };

  test("drain() is answered by the executor: the messages up to the answer's step, then its ids", async () => {
    const asked: unknown[] = [];
    const inbox = withBatch(
      ["m1", "m2", "m3"],
      { seen: "m2", ids: ["m9"] },
      asked,
    );

    const drained = await inbox.drain();

    expect(drained).toEqual([
      { name: "msg", data: { id: "m1" } },
      { name: "msg", data: { id: "m2" } },
      { name: "msg", data: { id: "m9" } },
    ]);
    expect(asked).toMatchObject([
      { op: "inbox:next", drain: true, unread: true, seen: "inbox" },
    ]);
  });

  test("max is split between what the SDK holds and the room it gives the executor", async () => {
    const asked: unknown[] = [];
    const inbox = withBatch(["m1", "m2"], { seen: "m2", ids: [] }, asked);

    const drained = await inbox.drain({ max: 1 });

    expect(drained).toEqual([{ name: "msg", data: { id: "m1" } }]);
    expect(asked).toMatchObject([{ room: 0 }]);
  });

  test("nextBatch() returns null when the executor answers with the timeout's null", async () => {
    const inbox = withBatch([], null);

    expect(await inbox.nextBatch({ timeout: "1m" })).toBeNull();
  });

  test("nextBatch() asks to wait only when nothing is unread", async () => {
    const asked: unknown[] = [];
    const inbox = withBatch([], { seen: "inbox", ids: ["m1"] }, asked);

    expect(await inbox.nextBatch()).toEqual([
      { name: "msg", data: { id: "m1" } },
    ]);
    expect(asked).toMatchObject([{ drain: false, unread: false }]);
  });
});
