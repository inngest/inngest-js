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
    record: async (_op, take) => {
      return take();
    },
    skip: async () => {
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
    expect(await inbox.nextBatch()).toEqual([]);
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

    expect(await again.next()).toBeUndefined();
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
