/**
 * @module
 * Tests for the messages an `Inbox` hands back: each carries a non-enumerable
 * `is()`, and `is()` narrows in both directions.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { eventType } from "../triggers/triggers.ts";
import type { EventIs, EventTypeToShape } from "../triggers/typeHelpers.ts";
import { Inbox, type InboxDeps } from "./Inbox.ts";

const review = eventType("review", {
  schema: z.object({ state: z.string() }),
});
const comment = eventType("comment", {
  schema: z.object({ body: z.string() }),
});

const fakeDeps = (): InboxDeps => {
  return {
    sources: [{ event: "review" }],
    id: "inbox",
    open: async () => {
      return { id: "inbox", inbox: "inbox" };
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
      return {
        found: "message",
        id: "m1",
        message: { name: "review", data: { state: "ok" } },
        timedOut: false,
      };
    },
    unread: () => {
      return ["m1"];
    },
    message: () => {
      return { name: "review", data: { state: "ok" } };
    },
    batch: async () => {
      return { cut: "m1" };
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
    close: async () => {
      return { cut: "m1" };
    },
  };
};

function expectIs(message: unknown): void {
  const m = message as { is: (types: unknown) => boolean };

  expect(typeof m.is).toBe("function");
  expect(Object.keys(m)).not.toContain("is");
  expect(JSON.parse(JSON.stringify(m))).toEqual({
    name: "review",
    data: { state: "ok" },
  });
  expect(m.is(review)).toBe(true);
  expect(m.is(comment)).toBe(false);
  expect(m.is([comment, review])).toBe(true);
}

describe("inbox messages have is()", () => {
  test("next", async () => {
    expectIs(await new Inbox(fakeDeps()).next());
  });

  test("nextBatch", async () => {
    const batch = await new Inbox(fakeDeps()).nextBatch();

    expect(batch).toHaveLength(1);
    expectIs(batch?.[0]);
  });

  test("drain", async () => {
    const batch = await new Inbox(fakeDeps()).drain();

    expect(batch).toHaveLength(1);
    expectIs(batch[0]);
  });

  test("batches", async () => {
    for await (const batch of new Inbox(fakeDeps()).batches()) {
      expect(batch).toHaveLength(1);
      expectIs(batch[0]);

      break;
    }
  });

  test("batches({ timeout }) ends the loop at the first timed out wait", async () => {
    const deps = fakeDeps();
    let reads = 0;
    deps.unread = (_inbox, taken) => {
      return taken === 0 ? ["m1"] : [];
    };
    deps.batch = async () => {
      reads += 1;

      return reads === 1 ? { cut: "m1" } : null;
    };

    const seen: unknown[][] = [];
    for await (const batch of new Inbox(deps).batches({ timeout: "1s" })) {
      seen.push(batch);
    }

    expect(seen).toHaveLength(1);
    expect(reads).toBe(2);
    expectIs(seen[0]?.[0]);
  });

  test("for await", async () => {
    for await (const message of new Inbox(fakeDeps())) {
      expectIs(message);

      break;
    }
  });

  test("close() returns the unread with is()", async () => {
    const unread = await new Inbox(fakeDeps()).close();

    expect(unread).toHaveLength(1);
    expectIs(unread[0]);
  });
});

describe("inbox message types", () => {
  test("m.is(type) narrows data to the schema", async () => {
    const m = (await new Inbox(fakeDeps()).next())!;

    if (m.is(review)) {
      expectTypeOf(m.data.state).toEqualTypeOf<string>();
    }
  });

  test("type.is(m) narrows data to the schema", async () => {
    const m = (await new Inbox(fakeDeps()).next())!;

    expectTypeOf(m.data).toEqualTypeOf<unknown>();

    if (review.is(m)) {
      expectTypeOf(m.data.state).toEqualTypeOf<string>();
    }
  });

  test("else excludes the named types from a union of messages", () => {
    type Message = (
      | EventTypeToShape<typeof review>
      | EventTypeToShape<typeof comment>
    ) &
      EventIs;

    const narrow = (m: Message) => {
      if (m.is(review)) {
        expectTypeOf(m.name).toEqualTypeOf<"review">();
      } else {
        expectTypeOf(m.name).toEqualTypeOf<"comment">();
        expectTypeOf(m.data.body).toEqualTypeOf<string>();
      }
    };

    expect(narrow).toBeTypeOf("function");
  });

  test("else on the default message type stays the default type", async () => {
    const m = (await new Inbox(fakeDeps()).next())!;

    if (!m.is(review)) {
      expectTypeOf(m.data).toEqualTypeOf<unknown>();
    }
  });
});
