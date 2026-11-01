/**
 * @module
 * Tests for the model-facing inbox tools, against an inbox that records what
 * they ask of it.
 */
import { describe, expect, test } from "vitest";
import {
  createInboxTools,
  type InboxToolInbox,
  type InboxToolMessage,
  type InboxToolsConfig,
  matchToCel,
} from "./inboxTools.ts";

/**
 * An inbox whose named inboxes get their messages from `queues`, by event
 * name, each with a read position of its own. The thread's own inbox reads the
 * queue named "handler".
 */
const fakeInbox = () => {
  const calls: unknown[][] = [];
  const closed: string[] = [];
  const queues = new Map<string, InboxToolMessage[]>();
  const read = new Map<string, number>();
  let delay = false;

  const queue = (name: string): InboxToolMessage[] => {
    if (!queues.has(name)) {
      queues.set(name, []);
    }

    return queues.get(name) as InboxToolMessage[];
  };
  const reader = (key: string, name: string) => {
    return {
      next: async (options: { timeout: number | string }) => {
        calls.push(["next", key, options]);

        const at = read.get(key) ?? 0;
        const message = queue(name)[at];

        if (message) {
          read.set(key, at + 1);
        }

        return message ?? null;
      },
      drain: async () => {
        calls.push(["drain", key]);

        const at = read.get(key) ?? 0;

        read.set(key, queue(name).length);

        return queue(name).slice(at);
      },
    };
  };
  const inbox: InboxToolInbox = {
    handler: reader("handler", "handler"),
    open: async (as, event, options) => {
      calls.push(["open", as, event, options]);

      if (delay) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      }

      const mine = reader(as, String(event));

      return {
        ...mine,
        close: async () => {
          closed.push(as);

          return mine.drain();
        },
      };
    },
  };

  return {
    inbox,
    calls,
    closed,
    push: (event: string, ...messages: InboxToolMessage[]) => {
      queue(event).push(...messages);
    },
    slow: () => {
      delay = true;
    },
  };
};

const config: InboxToolsConfig = {
  listen: [
    {
      event: "github/check_run",
      thread: '"slack:" + event.data.slackThread',
      if: 'event.data.repo == "app"',
      maxPerRun: 2,
    },
    { event: "ci/status", thread: "event.data.deployId" },
  ],
  maxListeners: 2,
  maxWait: "30m",
};

type Call = (input: unknown) => Promise<unknown>;

const setup = (overrides: Partial<InboxToolsConfig> = {}) => {
  const fake = fakeInbox();
  const tools = createInboxTools(fake.inbox, { ...config, ...overrides });
  const call = (name: keyof typeof tools, input: unknown = {}) => {
    return (tools[name].run as unknown as Call)(input);
  };

  return { ...fake, tools, call };
};

describe("inbox_listen", () => {
  test("listens to an allowed source with the configured thread and if, adding the model's match", async () => {
    const { call, calls } = setup();

    await expect(
      call("inbox_listen", {
        source: "github/check_run",
        match: { "data.pr": 12, "data.user": "U123" },
        as: "checks",
      }),
    ).resolves.toEqual({ listening: "checks", source: "github/check_run" });
    expect(calls[0]).toEqual([
      "open",
      "checks",
      "github/check_run",
      {
        thread: '"slack:" + event.data.slackThread',
        if: '(event.data.repo == "app") && (event.data.pr == 12 && event.data.user == "U123")',
      },
    ]);
  });

  test("refuses a source that isn't listed, naming the ones that are", async () => {
    const { call, calls } = setup();

    await expect(
      call("inbox_listen", { source: "stripe/charge", as: "x" }),
    ).rejects.toThrow(
      "stripe/charge is not a source you can listen to. Allowed: github/check_run, ci/status.",
    );
    expect(calls).toEqual([]);
  });

  test("never lets the model choose the thread: the schema drops it", async () => {
    const { call, calls, tools } = setup();
    const schema = tools.inbox_listen.input as unknown as {
      "~standard": { validate: (value: unknown) => Promise<unknown> };
    };
    const parsed = await schema["~standard"].validate({
      source: "ci/status",
      as: "ci",
      thread: "other",
    });

    expect(parsed).toEqual({ value: { source: "ci/status", as: "ci" } });

    await call("inbox_listen", { source: "ci/status", as: "ci" });

    expect(calls[0]?.[3]).toEqual({ thread: "event.data.deployId" });
  });

  test.each([
    { "data.x == 1 || true": 1 },
    { "data..x": 1 },
    { "data.": 1 },
    { "": 1 },
    { "data.if": 1 },
    { "data.x[0]": 1 },
    { "data.x\n": 1 },
    { "data.x": "x".repeat(201) },
    { "data.x": Number.POSITIVE_INFINITY },
    { "data.x": "\ud800" },
    Object.fromEntries(
      Array.from({ length: 9 }, (_, n) => {
        return [`data.f${n}`, 1];
      }),
    ),
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

  test("a failed listen doesn't remove a newer listener of the same name", async () => {
    const fake = fakeInbox();
    let calls = 0;
    const tools = createInboxTools(
      {
        ...fake.inbox,
        open: async (as, event, options) => {
          calls += 1;

          if (calls === 1) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 20);
            });

            throw new Error("backend down");
          }

          return fake.inbox.open(as, event, options);
        },
      },
      { listen: [{ event: "ci/status", thread: "t" }], maxListeners: 3 },
    );
    const run = (name: keyof typeof tools, input: unknown) => {
      return (tools[name].run as unknown as Call)(input);
    };
    const first = run("inbox_listen", { source: "ci/status", as: "a" });
    const firstSettled = first.catch(() => "failed");

    // Stopped and taken again while the first is still pending.
    const stopped = run("inbox_close", { as: "a" }).catch(() => "stop-failed");

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
    await run("inbox_listen", { source: "ci/status", as: "a" });
    await Promise.all([firstSettled, stopped]);
    await expect(run("inbox_next_batch", { as: "a" })).resolves.toEqual({
      messages: [],
    });
  });

  test("caps the listeners at once, and per source in a run", async () => {
    const { call } = setup();

    await call("inbox_listen", { source: "github/check_run", as: "a" });
    await call("inbox_listen", { source: "ci/status", as: "b" });
    await expect(
      call("inbox_listen", { source: "ci/status", as: "c" }),
    ).rejects.toThrow("Already 2 inboxes open");

    const perSource = setup({ maxListeners: 10 });

    await perSource.call("inbox_listen", {
      source: "github/check_run",
      as: "a",
    });
    await perSource.call("inbox_listen", {
      source: "github/check_run",
      as: "b",
    });
    await expect(
      perSource.call("inbox_listen", { source: "github/check_run", as: "c" }),
    ).rejects.toThrow("can be listened to 2 times in a run");
  });

  test("listens made at the same time can't pass the same checks", async () => {
    const one = setup({ maxListeners: 1 });

    one.slow();

    const results = await Promise.allSettled([
      one.call("inbox_listen", { source: "ci/status", as: "a" }),
      one.call("inbox_listen", { source: "ci/status", as: "b" }),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);

    const same = setup();

    same.slow();

    const named = await Promise.allSettled([
      same.call("inbox_listen", { source: "ci/status", as: "a" }),
      same.call("inbox_listen", { source: "github/check_run", as: "a" }),
    ]);

    expect(named.map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });

  test("a listen that fails gives its name and its slot back", async () => {
    const fake = fakeInbox();
    let first = true;
    const tools = createInboxTools(
      {
        ...fake.inbox,
        open: async (as, event, options) => {
          if (first) {
            first = false;

            throw new Error("backend down");
          }

          return fake.inbox.open(as, event, options);
        },
      },
      { listen: [{ event: "ci/status", thread: "t", maxPerRun: 1 }] },
    );
    const run = tools.inbox_listen.run as unknown as Call;

    await expect(run({ source: "ci/status", as: "a" })).rejects.toThrow(
      "backend down",
    );
    await expect(run({ source: "ci/status", as: "a" })).resolves.toEqual({
      listening: "a",
      source: "ci/status",
    });
  });

  test("refuses a name that is already in use and an event listed twice", async () => {
    const { call } = setup();

    await call("inbox_listen", { source: "ci/status", as: "a" });
    await expect(
      call("inbox_listen", { source: "ci/status", as: "a" }),
    ).rejects.toThrow("already open");
    expect(() =>
      createInboxTools(fakeInbox().inbox, {
        listen: [
          { event: "ci/status", thread: "a" },
          { event: "ci/status", thread: "b" },
        ],
      }),
    ).toThrow(/names an event twice/);
  });
});

describe("inbox_next, inbox_next_batch and inbox_close", () => {
  test("wait takes the next message of the listener, marked untrusted, or null on a timeout", async () => {
    const { call, calls, push } = setup();

    await call("inbox_listen", { source: "ci/status", as: "ci" });
    push("ci/status", { name: "ci/status", data: { state: "green" } });

    const got = (await call("inbox_next", { timeout: "10m", as: "ci" })) as {
      message: { source: string; content: string };
    };

    expect(got.message.source).toBe("ci/status");
    expect(got.message.content).toBe(
      '<untrusted source="ci/status">\n{"state":"green"}\n</untrusted>',
    );
    expect(calls.at(-1)).toEqual(["next", "ci", { timeout: 600_000 }]);
    await expect(
      call("inbox_next", { timeout: "1m", as: "ci" }),
    ).resolves.toEqual({
      message: null,
    });
  });

  test("an unknown name is an error that lists the open inboxes", async () => {
    const { call, push } = setup();

    await call("inbox_listen", { source: "ci/status", as: "ci" });
    await call("inbox_listen", { source: "github/check_run", as: "gh" });
    push("github/check_run", { name: "github/check_run", data: { n: 1 } });

    const got = (await call("inbox_next", { timeout: "1m", as: "gh" })) as {
      message: { source: string };
    };

    expect(got.message.source).toBe("github/check_run");
    await expect(
      call("inbox_next", { timeout: "1m", as: "nope" }),
    ).rejects.toThrow("No inbox named nope. Open: ci, gh.");
  });

  test("wait refuses a timeout above maxWait, and 0 reads without waiting", async () => {
    const { call, calls } = setup();

    await call("inbox_listen", { source: "ci/status", as: "ci" });
    await expect(call("inbox_next", { timeout: "31m" })).rejects.toThrow(
      "can wait at most 30m",
    );
    await call("inbox_next", { timeout: 0, as: "ci" });
    expect(calls.at(-1)).toEqual(["drain", "ci"]);
  });

  test("wait is a suspending tool for run_code", () => {
    expect(setup().tools.inbox_next.waits).toBe(true);
    expect(setup().tools.inbox_next_batch.waits).toBeUndefined();
  });

  test("read returns what the listeners have not read, long messages clipped", async () => {
    const { call, push } = setup();

    await call("inbox_listen", { source: "ci/status", as: "ci" });
    push(
      "ci/status",
      { name: "ci/status", data: { n: 1 } },
      { name: "ci/status", data: { text: "y".repeat(5000) } },
    );

    const { messages } = (await call("inbox_next_batch", { as: "ci" })) as {
      messages: { source: string; content: string }[];
    };

    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain("more characters");
    expect(messages[1]?.content.length).toBeLessThan(4_300);
    await expect(call("inbox_next_batch", { as: "ci" })).resolves.toEqual({
      messages: [],
    });
  });

  test("read takes what a listener has, and 'as' picks a listener", async () => {
    const { call, push } = setup();

    await call("inbox_listen", { source: "ci/status", as: "ci" });
    await call("inbox_listen", { source: "github/check_run", as: "gh" });
    push("ci/status", { name: "ci/status", data: { n: 1 } });
    push("github/check_run", { name: "github/check_run", data: { n: 99 } });

    const only = (await call("inbox_next_batch", { as: "gh" })) as {
      messages: { source: string }[];
    };

    expect(only.messages.map((message) => message.source)).toEqual([
      "github/check_run",
    ]);
  });

  test("a value can't become syntax: it is written as an escaped string literal", async () => {
    const { call, calls } = setup();

    await call("inbox_listen", {
      source: "ci/status",
      match: { "data.title": '") || (true' },
      as: "x",
    });
    await call("inbox_listen", {
      source: "github/check_run",
      match: { "data.title": "a\nb\u2028c\\" },
      as: "y",
    });

    expect(calls[0]?.[3]).toEqual({
      thread: "event.data.deployId",
      if: '(event.data.title == "\\") || (true")',
    });
    expect(calls[1]?.[3]).toEqual({
      thread: '"slack:" + event.data.slackThread',
      if: '(event.data.repo == "app") && (event.data.title == "a\\nb\\u2028c\\\\")',
    });
  });

  test("an empty match adds nothing", async () => {
    const { call, calls } = setup();

    await call("inbox_listen", { source: "ci/status", match: {}, as: "x" });

    expect(calls[0]?.[3]).toEqual({ thread: "event.data.deployId" });
  });

  test("a new execution that replays the calls rebuilds the listeners, so wait, read and stop still work", async () => {
    // Each step of a run is a new execution of the function: the tools are made
    // again and the loop replays its tool calls in order, listen included (a
    // memoized step inside the tool body).
    const fake = fakeInbox();
    const replay = () => {
      return createInboxTools(fake.inbox, config);
    };
    const run = (
      tools: ReturnType<typeof replay>,
      name: keyof typeof tools,
      input: unknown,
    ) => {
      return (tools[name].run as unknown as Call)(input);
    };
    const first = replay();

    await run(first, "inbox_listen", { source: "ci/status", as: "ci" });

    // The worker restarts here: new tools, the same calls replayed.
    const second = replay();

    await run(second, "inbox_listen", { source: "ci/status", as: "ci" });
    fake.push("ci/status", { name: "ci/status", data: { n: 1 } });
    await expect(
      run(second, "inbox_next", { timeout: "1m", as: "ci" }),
    ).resolves.toMatchObject({ message: { source: "ci/status" } });
    await expect(run(second, "inbox_close", { as: "ci" })).resolves.toEqual({
      closed: "ci",
    });
  });

  test("a run may wait only so long in all, and a source has a default cap", async () => {
    const { call } = setup({ maxTotalWait: "50m", maxWait: "30m" });

    await call("inbox_listen", { source: "ci/status", as: "a" });
    await call("inbox_next", { timeout: "30m" });
    await expect(call("inbox_next", { timeout: "30m" })).rejects.toThrow(
      "This run may wait 50m in all",
    );
    await call("inbox_next", { timeout: "20m" });
    await call("inbox_close", { as: "a" });
    await call("inbox_listen", { source: "ci/status", as: "b" });
    await call("inbox_close", { as: "b" });
    await call("inbox_listen", { source: "ci/status", as: "c" });
    await call("inbox_close", { as: "c" });
    // Stopping doesn't give a place back: the default is three per source.
    await expect(
      call("inbox_listen", { source: "ci/status", as: "d" }),
    ).rejects.toThrow("can be listened to 3 times");
  });

  test("without 'as' the tools read the thread's own inbox", async () => {
    const { call, calls, push } = setup();

    push("handler", { name: "agent/message", data: { text: "hi" } });

    const got = (await call("inbox_next", { timeout: "1m" })) as {
      message: { source: string };
    };

    expect(got.message.source).toBe("agent/message");
    expect(calls.at(-1)).toEqual(["next", "handler", { timeout: 60_000 }]);

    push("handler", { name: "agent/steer", data: { text: "x" } });

    const { messages } = (await call("inbox_next_batch")) as {
      messages: { source: string }[];
    };

    expect(messages.map((message) => message.source)).toEqual(["agent/steer"]);
  });

  test("inbox_close returns what the inbox had not read", async () => {
    const { call, push } = setup();

    await call("inbox_listen", { source: "ci/status", as: "ci" });
    push("ci/status", { name: "ci/status", data: { n: 1 } });

    const result = (await call("inbox_close", { as: "ci" })) as {
      closed: string;
      unread: { source: string }[];
    };

    expect(result.closed).toBe("ci");
    expect(result.unread.map((message) => message.source)).toEqual([
      "ci/status",
    ]);
  });

  test("a failed listen gives back its own slot, not the count it saw", async () => {
    const fake = fakeInbox();
    let first = true;
    const tools = createInboxTools(
      {
        ...fake.inbox,
        open: async (as, event, options) => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
          });

          if (first) {
            first = false;

            throw new Error("backend down");
          }

          return fake.inbox.open(as, event, options);
        },
      },
      { listen: [{ event: "ci/status", thread: "t", maxPerRun: 2 }] },
    );
    const run = tools.inbox_listen.run as unknown as Call;
    const results = await Promise.allSettled([
      run({ source: "ci/status", as: "a" }),
      run({ source: "ci/status", as: "b" }),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    // One listener runs, so one more is allowed and a third is not.
    await run({ source: "ci/status", as: "c" });
    await expect(run({ source: "ci/status", as: "d" })).rejects.toThrow(
      "can be listened to 2 times",
    );
  });

  test("close closes the inbox and frees its name and its slot", async () => {
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
    [{ "data.a": 1 }, "event.data.a == 1"],
    [
      { "data.a": "x", "data.b": true },
      'event.data.a == "x" && event.data.b == true',
    ],
    [{ "data.a": -2.5 }, "event.data.a == -2.5"],
    [{ "data.a": "\u0085\u007f" }, 'event.data.a == "\\u0085\\u007f"'],
    [{ "data.a": "ünï" }, 'event.data.a == "ünï"'],
    [{}, undefined],
  ])("%j", (match, cel) => {
    expect(matchToCel(match)).toBe(cel);
  });

  test("a key is at most 128 characters", () => {
    const long = `data.${"a".repeat(123)}`;

    expect(matchToCel({ [long]: 1 })).toBe(`event.${long} == 1`);
    expect(() => matchToCel({ [`${long}a`]: 1 })).toThrow("at most 128");
  });
});
