/**
 * @module
 * Tests for the model's inbox tools, `inbox_listen` and `inbox_close`,
 * against an inbox that records what they ask of it.
 */
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { eventType } from "../../../components/triggers/triggers.ts";
import {
  createListenTools,
  type InboxToolInbox,
  type InboxToolMessage,
  matchToCel,
} from "./inboxTools.ts";

const pullRequest = eventType("github/pull_request", {
  schema: z.object({ pull_request: z.object({ number: z.number() }) }),
});
const status = eventType("ci/status", { schema: z.object({ n: z.number() }) });

const fakeInbox = () => {
  const calls: unknown[][] = [];
  const closed: string[] = [];
  const unread = new Map<string, InboxToolMessage[]>();
  let delay = false;

  const inbox: InboxToolInbox = {
    open: async (as, event, options) => {
      calls.push(["open", as, event.name, options]);

      if (delay) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      }

      return {
        close: async () => {
          closed.push(as);

          return unread.get(as) ?? [];
        },
      };
    },
  };

  return {
    inbox,
    calls,
    closed,
    leave: (as: string, ...messages: InboxToolMessage[]) => {
      unread.set(as, messages);
    },
    slow: () => {
      delay = true;
    },
  };
};

type Call = (input: unknown) => Promise<unknown>;

const setup = () => {
  const fake = fakeInbox();
  const tools = createListenTools(fake.inbox, [pullRequest, status]);
  const call = (name: "inbox_listen" | "inbox_close", input: unknown = {}) => {
    return (tools[name].run as unknown as Call)(input);
  };

  return { ...fake, tools, call };
};

describe("inbox_listen", () => {
  test("a dotted match path lets through only events whose data has that value there", async () => {
    const { call, calls } = setup();

    await expect(
      call("inbox_listen", {
        source: "github/pull_request",
        match: { "pull_request.number": 12, action: "opened" },
        as: "pr",
      }),
    ).resolves.toEqual({ listening: "pr", source: "github/pull_request" });
    expect(calls[0]).toEqual([
      "open",
      "pr",
      "github/pull_request",
      {
        if: 'async.data.pull_request.number == 12 && async.data.action == "opened"',
      },
    ]);
  });

  test("a type outside listen is refused with a message naming the allowed ones", async () => {
    const { call, calls } = setup();

    await expect(
      call("inbox_listen", { source: "stripe/charge", as: "x" }),
    ).rejects.toThrow(
      "stripe/charge is not a source you can listen to. Allowed: github/pull_request, ci/status.",
    );
    expect(calls).toEqual([]);
  });

  test("eight match fields are fine and a ninth is an error the model sees", async () => {
    const { call, calls } = setup();
    const fields = (count: number) => {
      return Object.fromEntries(
        Array.from({ length: count }, (_, n) => {
          return [`f${n}`, 1];
        }),
      );
    };

    await call("inbox_listen", {
      source: "ci/status",
      match: fields(8),
      as: "eight",
    });
    await expect(
      call("inbox_listen", {
        source: "ci/status",
        match: fields(9),
        as: "nine",
      }),
    ).rejects.toThrow('"match" may name at most 8 fields.');
    expect(calls).toHaveLength(1);
  });

  test("the model cannot choose the thread: the schema drops it", async () => {
    const { tools } = setup();
    const schema = tools.inbox_listen.input as unknown as {
      "~standard": { validate: (value: unknown) => Promise<unknown> };
    };
    const parsed = await schema["~standard"].validate({
      source: "ci/status",
      as: "ci",
      thread: "other",
    });

    expect(parsed).toEqual({ value: { source: "ci/status", as: "ci" } });
  });

  test.each([
    { "x == 1 || true": 1 },
    { "a..x": 1 },
    { "a.": 1 },
    { "": 1 },
    { "a.if": 1 },
    { "a.x[0]": 1 },
    { "a.x\n": 1 },
    { x: "x".repeat(201) },
    { x: Number.POSITIVE_INFINITY },
    { x: "\ud800" },
  ])(
    "refuses a match that is not plain fields and values: %j",
    async (match) => {
      const { call, calls } = setup();

      await expect(
        call("inbox_listen", { source: "ci/status", match, as: "ci" }),
      ).rejects.toThrow(/match/);
      expect(calls).toEqual([]);
    },
  );

  test("caps the inboxes open at once, and per source in a run", async () => {
    const { call } = setup();

    for (const as of ["a", "b", "c", "d", "e"]) {
      await call("inbox_listen", {
        source: as < "d" ? "ci/status" : "github/pull_request",
        as,
      }).catch(() => undefined);
    }

    const overall = setup();

    await overall.call("inbox_listen", { source: "ci/status", as: "a" });
    await overall.call("inbox_listen", { source: "ci/status", as: "b" });
    await overall.call("inbox_listen", { source: "ci/status", as: "c" });
    await expect(
      overall.call("inbox_listen", { source: "ci/status", as: "d" }),
    ).rejects.toThrow("can be listened to 3 times in a run");
  });

  test("listens made at the same time can't pass the same checks", async () => {
    const same = setup();

    same.slow();

    const named = await Promise.allSettled([
      same.call("inbox_listen", { source: "ci/status", as: "a" }),
      same.call("inbox_listen", { source: "github/pull_request", as: "a" }),
    ]);

    expect(named.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  test("a listen that fails gives its name and its slot back", async () => {
    const fake = fakeInbox();
    let first = true;
    const tools = createListenTools(
      {
        open: async (as, event, options) => {
          if (first) {
            first = false;

            throw new Error("backend down");
          }

          return fake.inbox.open(as, event, options);
        },
      },
      [status],
    );
    const run = tools.inbox_listen.run as unknown as Call;

    await expect(run({ source: "ci/status", as: "a" })).rejects.toThrow(
      "backend down",
    );
    await run({ source: "ci/status", as: "a" });
    await run({ source: "ci/status", as: "b" });
    await run({ source: "ci/status", as: "c" });
    await expect(run({ source: "ci/status", as: "d" })).rejects.toThrow(
      "can be listened to 3 times",
    );
  });

  test("refuses a name already in use and a type listed twice", async () => {
    const { call } = setup();

    await call("inbox_listen", { source: "ci/status", as: "a" });
    await expect(
      call("inbox_listen", { source: "ci/status", as: "a" }),
    ).rejects.toThrow("already open");
    expect(() =>
      createListenTools(fakeInbox().inbox, [status, status]),
    ).toThrow(/twice/);
  });
});

describe("inbox_close", () => {
  test("returns what the inbox had not read, marked untrusted", async () => {
    const { call, leave } = setup();

    await call("inbox_listen", { source: "ci/status", as: "ci" });
    leave("ci", { name: "ci/status", data: { n: 1 } });

    const result = (await call("inbox_close", { as: "ci" })) as {
      closed: string;
      unread: { source: string }[];
    };

    expect(result.closed).toBe("ci");
    expect(result.unread.map((message) => message.source)).toEqual([
      "ci/status",
    ]);
  });

  test("closes the inbox and frees its name and its slot", async () => {
    const { call, closed } = setup();

    await call("inbox_listen", { source: "ci/status", as: "a" });
    await call("inbox_listen", { source: "ci/status", as: "b" });
    await expect(call("inbox_close", { as: "a" })).resolves.toEqual({
      closed: "a",
    });
    expect(closed).toEqual(["a"]);
    await call("inbox_listen", { source: "ci/status", as: "a" });
    await expect(call("inbox_close", { as: "zzz" })).rejects.toThrow(
      "No inbox named zzz. Open: b, a.",
    );
  });
});

describe("matchToCel", () => {
  test.each([
    [{ a: 1 }, "async.data.a == 1"],
    [{ a: "x", b: true }, 'async.data.a == "x" && async.data.b == true'],
    [{ a: -2.5 }, "async.data.a == -2.5"],
    [{ "p.q": "\u0085\u007f" }, 'async.data.p.q == "\\u0085\\u007f"'],
    [{ a: "ünï" }, 'async.data.a == "ünï"'],
    [{}, undefined],
  ])("%j", (match, cel) => {
    expect(matchToCel(match)).toBe(cel);
  });

  test("a key is at most 128 characters", () => {
    const long = "a".repeat(128);

    expect(matchToCel({ [long]: 1 })).toBe(`async.data.${long} == 1`);
    expect(() => matchToCel({ [`${long}a`]: 1 })).toThrow("at most 128");
  });
});
