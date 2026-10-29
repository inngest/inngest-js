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
  isWrappable,
} from "./inboxTools.ts";

/**
 * An inbox whose listeners get their messages from `queues`, by event name,
 * with a read position of their own, like a view.
 */
const fakeInbox = () => {
  const calls: unknown[][] = [];
  const stopped: string[] = [];
  const queues = new Map<string, InboxToolMessage[]>();
  const read = new Map<string, number>();
  let listens = 0;
  let delay = false;

  const queue = (event: string): InboxToolMessage[] => {
    if (!queues.has(event)) {
      queues.set(event, []);
    }

    return queues.get(event) as InboxToolMessage[];
  };
  const inbox: InboxToolInbox = {
    listen: async (event, options) => {
      listens += 1;

      const n = listens;

      calls.push(["listen", event, options]);

      if (delay) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      }

      return {
        stop: async () => {
          stopped.push(`l${n}`);
        },
      };
    },
    of: (event) => {
      const name = String(event);

      return {
        next: async (options) => {
          calls.push(["next", name, options]);

          const at = read.get(name) ?? 0;
          const message = queue(name)[at];

          if (message) {
            read.set(name, at + 1);
          }

          return message ?? null;
        },
        unread: async () => {
          calls.push(["unread", name]);

          const at = read.get(name) ?? 0;

          read.set(name, queue(name).length);

          return queue(name).slice(at);
        },
        current: async () => {
          calls.push(["current", name]);

          return [...queue(name)];
        },
      };
    },
  };

  return {
    inbox,
    calls,
    stopped,
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
  test("listens to an allowed source with the configured thread and if, adding the model's if", async () => {
    const { call, calls } = setup();

    await expect(
      call("inbox_listen", {
        source: "github/check_run",
        if: "event.data.pr == 12",
        as: "checks",
      }),
    ).resolves.toEqual({ listening: "checks", source: "github/check_run" });
    expect(calls[0]).toEqual([
      "listen",
      "github/check_run",
      {
        thread: '"slack:" + event.data.slackThread',
        if: '(event.data.repo == "app") && (event.data.pr == 12)',
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

    expect(calls[0]?.[2]).toEqual({ thread: "event.data.deployId" });
  });

  test.each([
    "true) || (event.data.x == 1",
    "event.data.a == (1",
    "event.data.a == 'x",
    "x".repeat(501),
    "false // (\n) || (true // )\n",
    "false // ( ) || (true // )",
    'event.data.a == r"\\") || (true"',
    "true # )",
    "a\nb",
  ])(
    "refuses an if that could escape the configured one: %j",
    async (narrow) => {
      const { call, calls } = setup();

      await expect(
        call("inbox_listen", { source: "ci/status", if: narrow, as: "ci" }),
      ).rejects.toThrow(/"if" must be a single-line CEL expression/);
      expect(calls).toEqual([]);
    },
  );

  test("refuses a quoted identifier that hides parentheses from the check", async () => {
    const { call } = setup();

    await expect(
      call("inbox_listen", {
        source: "ci/status",
        if: "event.data.`(` ) || true || (event.data.`)`",
        as: "ci",
      }),
    ).rejects.toThrow(/"if" must be a single-line CEL expression/);
  });

  test("a failed listen doesn't remove a newer listener of the same name", async () => {
    const fake = fakeInbox();
    let calls = 0;
    const tools = createInboxTools(
      {
        ...fake.inbox,
        listen: async (event, options) => {
          calls += 1;

          if (calls === 1) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 20);
            });

            throw new Error("backend down");
          }

          return fake.inbox.listen(event, options);
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
    const stopped = run("inbox_stop", { as: "a" }).catch(() => "stop-failed");

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
    await run("inbox_listen", { source: "ci/status", as: "a" });
    await Promise.all([firstSettled, stopped]);
    await expect(run("inbox_read", { as: "a" })).resolves.toEqual({
      messages: [],
    });
  });

  test("caps the listeners at once, and per source in a run", async () => {
    const { call } = setup();

    await call("inbox_listen", { source: "github/check_run", as: "a" });
    await call("inbox_listen", { source: "ci/status", as: "b" });
    await expect(
      call("inbox_listen", { source: "ci/status", as: "c" }),
    ).rejects.toThrow("Already listening 2 times");

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
        listen: async (event, options) => {
          if (first) {
            first = false;

            throw new Error("backend down");
          }

          return fake.inbox.listen(event, options);
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
    ).rejects.toThrow("already running");
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

describe("inbox_wait, inbox_read and inbox_stop", () => {
  test("wait takes the next message of the listener, marked untrusted, or null on a timeout", async () => {
    const { call, calls, push } = setup();

    await call("inbox_listen", { source: "ci/status", as: "ci" });
    push("ci/status", { name: "ci/status", data: { state: "green" } });

    const got = (await call("inbox_wait", { timeout: "10m" })) as {
      message: { source: string; content: string };
    };

    expect(got.message.source).toBe("ci/status");
    expect(got.message.content).toBe(
      '<untrusted source="ci/status">\n{"state":"green"}\n</untrusted>',
    );
    expect(calls.at(-1)).toEqual(["next", "ci/status", { timeout: 600_000 }]);
    await expect(call("inbox_wait", { timeout: "1m" })).resolves.toEqual({
      message: null,
    });
  });

  test("wait needs 'as' when more than one listener runs, and a listener to exist", async () => {
    const { call, push } = setup();

    await expect(call("inbox_wait", { timeout: "1m" })).rejects.toThrow(
      "not listening to anything",
    );
    await call("inbox_listen", { source: "ci/status", as: "ci" });
    await call("inbox_listen", { source: "github/check_run", as: "gh" });
    await expect(call("inbox_wait", { timeout: "1m" })).rejects.toThrow(
      'say which one to wait for with "as"',
    );

    push("github/check_run", { name: "github/check_run", data: { n: 1 } });

    const got = (await call("inbox_wait", { timeout: "1m", as: "gh" })) as {
      message: { source: string };
    };

    expect(got.message.source).toBe("github/check_run");
    await expect(
      call("inbox_wait", { timeout: "1m", as: "nope" }),
    ).rejects.toThrow("No listener named nope. Running: ci, gh.");
  });

  test("wait refuses a timeout above maxWait, and 0 reads without waiting", async () => {
    const { call, calls } = setup();

    await call("inbox_listen", { source: "ci/status", as: "ci" });
    await expect(call("inbox_wait", { timeout: "31m" })).rejects.toThrow(
      "can wait at most 30m",
    );
    await call("inbox_wait", { timeout: 0 });
    expect(calls.at(-1)).toEqual(["next", "ci/status", { timeout: 0 }]);
  });

  test("wait is a suspending tool for run_code", () => {
    expect(setup().tools.inbox_wait.waits).toBe(true);
    expect(setup().tools.inbox_read.waits).toBeUndefined();
  });

  test("read returns what the listeners have not read, long messages clipped", async () => {
    const { call, push } = setup();

    await call("inbox_listen", { source: "ci/status", as: "ci" });
    push(
      "ci/status",
      { name: "ci/status", data: { n: 1 } },
      { name: "ci/status", data: { text: "y".repeat(5000) } },
    );

    const { messages } = (await call("inbox_read")) as {
      messages: { source: string; content: string }[];
    };

    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain("more characters");
    expect(messages[1]?.content.length).toBeLessThan(4_300);
    await expect(call("inbox_read")).resolves.toEqual({ messages: [] });
  });

  test("read with all returns the latest 20 and how many there are, and 'as' picks a listener", async () => {
    const { call, push, calls } = setup();

    await call("inbox_listen", { source: "ci/status", as: "ci" });
    await call("inbox_listen", { source: "github/check_run", as: "gh" });

    for (let n = 0; n < 25; n += 1) {
      push("ci/status", { name: "ci/status", data: { n } });
    }

    push("github/check_run", { name: "github/check_run", data: { n: 99 } });

    const { messages, total } = (await call("inbox_read", { all: true })) as {
      total: number;
      messages: { content: string }[];
    };

    expect(total).toBe(26);
    expect(messages).toHaveLength(20);
    expect(calls.filter((entry) => entry[0] === "current")).toHaveLength(2);

    const only = (await call("inbox_read", { as: "gh" })) as {
      messages: { source: string }[];
    };

    expect(only.messages.map((message) => message.source)).toEqual([
      "github/check_run",
    ]);
  });

  test("two listeners on one event share its messages, so a read shows each once", async () => {
    const { call, push } = setup({ maxListeners: 5 });

    await call("inbox_listen", { source: "github/check_run", as: "a" });
    await call("inbox_listen", {
      source: "github/check_run",
      as: "b",
      if: "event.data.pr == 1",
    });
    push("github/check_run", { name: "github/check_run", data: { pr: 1 } });

    const { messages } = (await call("inbox_read")) as {
      messages: unknown[];
    };

    expect(messages).toHaveLength(1);
  });

  test("a failed listen gives back its own slot, not the count it saw", async () => {
    const fake = fakeInbox();
    let first = true;
    const tools = createInboxTools(
      {
        ...fake.inbox,
        listen: async (event, options) => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
          });

          if (first) {
            first = false;

            throw new Error("backend down");
          }

          return fake.inbox.listen(event, options);
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

  test("stop stops the listener and frees its name and its slot", async () => {
    const { call, stopped } = setup();

    await call("inbox_listen", { source: "ci/status", as: "a" });
    await call("inbox_listen", { source: "ci/status", as: "b" });
    await expect(call("inbox_stop", { as: "a" })).resolves.toEqual({
      stopped: "a",
    });
    expect(stopped).toEqual(["l1"]);
    await call("inbox_listen", { source: "ci/status", as: "a" });
    await expect(call("inbox_stop", { as: "zzz" })).rejects.toThrow(
      "No listener named zzz. Running: b, a.",
    );
  });
});

describe("isWrappable", () => {
  test.each([
    ["event.data.a == 1", true],
    ["(a) && (b)", true],
    ['event.data.s == ")"', true],
    ["a) || (b", false],
    ["(a", false],
    ["'x", false],
    ["a // (", false],
    ["a # b", false],
    ['r"x"', false],
    ["a\nb", false],
    ["event.data.driver == 1", true],
    ['event.data.url.startsWith("https://x")', true],
    ['event.data.title.contains("#12")', true],
    ["event.data.k == 'r'", true],
    ['event.data.k == "a\\"r"', true],
    ['"""a""" == b', false],
    ["rb'x'", false],
    ["event.data.`a`", false],
  ])("%s", (expression, ok) => {
    expect(isWrappable(expression)).toBe(ok);
  });
});
