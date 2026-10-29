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

const fakeInbox = () => {
  const calls: unknown[][] = [];
  const stopped: string[] = [];
  const queue: InboxToolMessage[] = [];
  const history: InboxToolMessage[] = [];
  let listens = 0;
  const inbox: InboxToolInbox = {
    listen: async (event, options) => {
      const n = (listens += 1);

      calls.push(["listen", event, options]);

      return {
        stop: async () => {
          stopped.push(`l${n}`);
        },
      };
    },
    next: async (options) => {
      calls.push(["next", options]);

      return queue.shift() ?? null;
    },
    unread: async () => {
      calls.push(["unread"]);

      return queue.splice(0);
    },
    current: async () => {
      calls.push(["current"]);

      return [...history, ...queue];
    },
  };

  return { inbox, calls, stopped, queue };
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
    expect(calls).toEqual([
      [
        "listen",
        "github/check_run",
        {
          thread: '"slack:" + event.data.slackThread',
          if: '(event.data.repo == "app") && (event.data.pr == 12)',
        },
      ],
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

  test("never lets the model choose the thread", async () => {
    const { call, calls } = setup();

    await call("inbox_listen", {
      source: "ci/status",
      as: "ci",
      thread: "other",
    });

    expect(calls[0]?.[2]).toEqual({ thread: "event.data.deployId" });
  });

  test.each([
    "true) || (event.data.x == 1",
    "event.data.a == (1",
    "event.data.a == 'x",
    "x".repeat(501),
  ])(
    "refuses an if that could escape the configured one: %s",
    async (narrow) => {
      const { call, calls } = setup();

      await expect(
        call("inbox_listen", { source: "ci/status", if: narrow, as: "ci" }),
      ).rejects.toThrow(/"if" must be a CEL expression/);
      expect(calls).toEqual([]);
    },
  );

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

  test("refuses a name that is already in use", async () => {
    const { call } = setup();

    await call("inbox_listen", { source: "ci/status", as: "a" });
    await expect(
      call("inbox_listen", { source: "ci/status", as: "a" }),
    ).rejects.toThrow("already running");
  });
});

describe("inbox_wait, inbox_read and inbox_stop", () => {
  test("wait returns the next message marked untrusted, or null on a timeout", async () => {
    const { call, calls, queue } = setup();

    queue.push({ name: "ci/status", data: { state: "green" } });

    const got = (await call("inbox_wait", { timeout: "10m" })) as {
      message: { source: string; content: string };
    };

    expect(got.message.source).toBe("ci/status");
    expect(got.message.content).toBe(
      '<untrusted source="ci/status">\n{"state":"green"}\n</untrusted>',
    );
    expect(calls[0]).toEqual(["next", { timeout: 600_000 }]);
    await expect(call("inbox_wait", { timeout: "1m" })).resolves.toEqual({
      message: null,
    });
  });

  test("wait refuses a timeout above maxWait, and 0 reads without waiting", async () => {
    const { call, calls } = setup();

    await expect(call("inbox_wait", { timeout: "31m" })).rejects.toThrow(
      "can wait at most 30m",
    );
    await call("inbox_wait", { timeout: 0 });
    expect(calls).toEqual([["next", { timeout: 0 }]]);
  });

  test("wait is a suspending tool for run_code", () => {
    expect(setup().tools.inbox_wait.waits).toBe(true);
    expect(setup().tools.inbox_read.waits).toBeUndefined();
  });

  test("read returns what is unread, long messages clipped", async () => {
    const { call, queue, calls } = setup();

    queue.push(
      { name: "ci/status", data: { n: 1 } },
      { name: "ci/status", data: { text: "y".repeat(5000) } },
    );

    const { messages } = (await call("inbox_read")) as {
      messages: { source: string; content: string }[];
    };

    expect(calls).toEqual([["unread"]]);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain("more characters");
    expect(messages[1]?.content.length).toBeLessThan(4_300);
    await expect(call("inbox_read")).resolves.toEqual({ messages: [] });
  });

  test("read with all returns the latest 20 of everything and how many there are", async () => {
    const { call, queue, calls } = setup();

    for (let n = 0; n < 25; n += 1) {
      queue.push({ name: "ci/status", data: { n } });
    }

    const { messages, total } = (await call("inbox_read", { all: true })) as {
      total: number;
      messages: { content: string }[];
    };

    expect(calls).toEqual([["current"]]);
    expect(total).toBe(25);
    expect(messages).toHaveLength(20);
    expect(messages[0]?.content).toContain('{"n":5}');
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
  ])("%s", (expression, ok) => {
    expect(isWrappable(expression)).toBe(ok);
  });
});
