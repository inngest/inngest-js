/**
 * @module
 * Tests for reading and closing an `Inbox` against fake dependencies: what each
 * read asks the executor, what a cut answers, what `close()` sends, and what a
 * closed inbox returns.
 */
import { Inbox, type InboxDeps, inboxOpenedPromise } from "./Inbox.ts";

/**
 * Fake dependencies over a run state that holds the messages `ids`, oldest
 * first. `waits`, `batches` and `closes` record what the inbox sent.
 */
const fakeDeps = (ids: string[] = []) => {
  const waits: unknown[] = [];
  const batches: unknown[] = [];
  const closes: unknown[] = [];

  const deps: InboxDeps = {
    sources: [{ event: "msg" }],
    id: "inbox",
    open: async () => {
      return { id: "inbox", inbox: "inbox" };
    },
    waitId: (op) => {
      return `hash:${op}`;
    },
    wait: (op, inbox, seen, timeout) => {
      waits.push({ op, inbox, seen, timeout });

      return new Promise(() => {
        return undefined;
      });
    },
    read: (_inbox, taken) => {
      const id = ids[taken];

      return id === undefined
        ? { found: "nothing" }
        : { found: "message", id, message: message(id), timedOut: false };
    },
    unread: (_inbox, taken, upTo) => {
      return ids.slice(taken, upTo === undefined ? undefined : cutEnd(upTo));
    },
    message: (id) => {
      return message(id);
    },
    batch: async (op, read) => {
      batches.push({ op, ...read });

      return { cut: ids.at(-1) ?? null };
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

      return { cut: ids.at(-1) ?? null };
    },
  };

  const cutEnd = (upTo: string): number => {
    return ids.indexOf(upTo) + 1;
  };

  return { deps, waits, batches, closes };
};

const message = (id: string) => {
  return { name: "msg", data: { id } };
};

const tick = () => {
  return new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
};

describe("closing an inbox", () => {
  test("close() sends only the inbox, and returns the messages up to the cut that were not read", async () => {
    const { deps, closes } = fakeDeps(["m1", "m2"]);
    const inbox = new Inbox(deps);

    expect(await inbox.next()).toMatchObject(message("m1"));

    const unread = await inbox.close();

    expect(closes).toEqual([
      { op: "inbox:close", closing: { inbox: "inbox" } },
    ]);
    expect(unread).toMatchObject([message("m2")]);
    expect(inbox.closed).toBe(true);
  });

  test("a close whose cut is null returns nothing", async () => {
    const { deps } = fakeDeps([]);

    expect(await new Inbox(deps).close()).toEqual([]);
  });

  test("a closed inbox reads nothing and sends no op", async () => {
    const { deps, waits, batches } = fakeDeps(["m1"]);
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
    expect(waits).toEqual([]);
    expect(batches).toEqual([]);
  });

  test("a read that starts while the close is in flight ends without reporting a wait", async () => {
    const { deps, waits, batches } = fakeDeps([]);
    let finish: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    deps.close = async () => {
      await gate;

      return { cut: null };
    };
    const inbox = new Inbox(deps);

    const closing = inbox.close();
    const late = inbox.next();
    const lateBatch = inbox.nextBatch();

    finish();
    await closing;

    expect(await late).toBeUndefined();
    expect(await lateBatch).toBeUndefined();
    expect(waits).toEqual([]);
    expect(batches).toEqual([]);
  });

  test("a read that starts while the close is in flight still takes a message it can already read", async () => {
    const { deps, waits } = fakeDeps(["m1"]);
    deps.close = () => {
      return new Promise(() => {
        return undefined;
      });
    };
    const inbox = new Inbox(deps);

    void inbox.close();

    expect(await inbox.next()).toMatchObject(message("m1"));
    expect(waits).toEqual([]);
  });

  test("a read that found nothing and whose close is in state ends when the close is replayed past", async () => {
    const { deps, waits } = fakeDeps([]);
    deps.closed = (op) => {
      return op === "inbox:close";
    };
    const inbox = new Inbox(deps);

    const ending = inbox.next();
    await inbox.close();

    expect(await ending).toBeUndefined();
    expect(waits).toEqual([]);
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

describe("reads on one inbox", () => {
  test("parallel reads are served in order, each taking the next message", async () => {
    const { deps } = fakeDeps(["m1", "m2", "m3"]);
    const inbox = new Inbox(deps);

    const reads = await Promise.all([inbox.next(), inbox.next(), inbox.next()]);

    expect(reads).toMatchObject([message("m1"), message("m2"), message("m3")]);
  });

  test("a read with nothing unread reports a wait with the inbox and the last step seen, and no filter", async () => {
    const { deps, waits } = fakeDeps([]);
    const inbox = new Inbox(deps);

    void inbox.next({ timeout: "1m" });
    await tick();

    expect(waits).toEqual([
      { op: "inbox:next", inbox: "inbox", seen: "inbox", timeout: "1m" },
    ]);
  });

  test("a read behind a waiting read does not report until it ends", async () => {
    const { deps, waits } = fakeDeps([]);
    const inbox = new Inbox(deps);

    void inbox.next();
    void inbox.next();
    await tick();

    expect(waits).toHaveLength(1);
  });
});

describe("batch reads", () => {
  test("drain() takes the messages up to the executor's cut", async () => {
    const { deps, batches } = fakeDeps(["m1", "m2", "m3"]);
    deps.batch = async (op, read) => {
      batches.push({ op, ...read });

      return { cut: "m2" };
    };

    const drained = await new Inbox(deps).drain();

    expect(drained).toMatchObject([message("m1"), message("m2")]);
    expect(batches).toEqual([
      {
        op: "inbox:next",
        inbox: "inbox",
        seen: "inbox",
        drain: true,
        unread: true,
      },
    ]);
  });

  test("a batch read sends max as it is, and takes at most that many", async () => {
    const { deps, batches } = fakeDeps(["m1", "m2", "m3"]);

    const drained = await new Inbox(deps).drain({ max: 2 });

    expect(drained).toMatchObject([message("m1"), message("m2")]);
    expect(batches).toMatchObject([{ max: 2 }]);
  });

  test("a cut of null is an empty batch", async () => {
    const { deps } = fakeDeps([]);

    expect(await new Inbox(deps).drain()).toEqual([]);
  });

  test("nextBatch() returns null when the executor answers with the timeout's null", async () => {
    const { deps } = fakeDeps([]);
    deps.batch = async () => {
      return null;
    };

    expect(await new Inbox(deps).nextBatch({ timeout: "1m" })).toBeNull();
  });

  test("nextBatch() asks to wait only when nothing is unread", async () => {
    const empty = fakeDeps([]);
    empty.deps.batch = async (op, read) => {
      empty.batches.push({ op, ...read });

      return { cut: "m1" };
    };
    empty.deps.unread = (_inbox, taken, upTo) => {
      return upTo === undefined || taken > 0 ? [] : ["m1"];
    };

    await new Inbox(empty.deps).nextBatch();
    expect(empty.batches).toMatchObject([{ drain: false, unread: false }]);

    const held = fakeDeps(["m1"]);
    await new Inbox(held.deps).nextBatch();
    expect(held.batches).toMatchObject([{ drain: false, unread: true }]);
  });

  test("the second batch starts after the first one's messages", async () => {
    const { deps } = fakeDeps(["m1", "m2", "m3"]);
    const inbox = new Inbox(deps);

    expect(await inbox.drain({ max: 1 })).toMatchObject([message("m1")]);
    expect(await inbox.drain()).toMatchObject([message("m2"), message("m3")]);
  });
});

describe("opening an inbox", () => {
  test("inboxOpenedPromise() settles once the open is replayed past", async () => {
    const { deps } = fakeDeps([]);
    let finish: () => void = () => undefined;
    deps.open = () => {
      return new Promise((resolve) => {
        finish = () => {
          resolve({ id: "inbox", inbox: "inbox" });
        };
      });
    };
    const inbox = new Inbox(deps);
    let opened = false;
    void inboxOpenedPromise(inbox).then(() => {
      opened = true;
    });

    await tick();
    expect(opened).toBe(false);

    finish();
    await tick();
    expect(opened).toBe(true);
  });
});
