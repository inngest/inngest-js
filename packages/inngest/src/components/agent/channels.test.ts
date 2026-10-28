/**
 * @module
 * Tests for channels: adapters, `report()` destinations, the trigger helpers
 * and the Slack and GitHub adapters against a stub `fetch`.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { createAgentFunction } from "./agentFunction.ts";
import {
  askThrough,
  type ChannelMessage,
  createReporter,
  defineChannel,
} from "./channels.ts";
import { github } from "./github.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { slack } from "./slack.ts";
import { run } from "./test-helpers.ts";

const recorder = () => {
  const posts: ChannelMessage[] = [];

  return {
    posts,
    channel: defineChannel({
      post: async (message) => {
        posts.push(message);
      },
    }),
  };
};

const direct = async (id: string, fn: () => Promise<void>) => {
  await fn();

  return id;
};

describe("defineChannel and askThrough", () => {
  test("a channel needs post", () => {
    expect(() => {
      return defineChannel({} as never);
    }).toThrow("needs a `post`");
  });

  test("askThrough renders through ask, and names a channel that cannot", async () => {
    const asks: unknown[] = [];

    const asking = defineChannel({
      post: async () => {},
      ask: async (ask) => {
        asks.push(ask);
      },
    });

    await askThrough(asking, { signal: "s1", question: "ok?" });
    expect(asks).toEqual([{ signal: "s1", question: "ok?" }]);

    await expect(
      askThrough(recorder().channel, { signal: "s", question: "q" }),
    ).rejects.toThrow("cannot ask");
  });
});

describe("report", () => {
  test("posts to main by default, as a step per destination", async () => {
    const main = recorder();
    const ids: string[] = [];

    const report = createReporter(
      { main: main.channel },
      undefined,
      (id, fn) => {
        ids.push(id);

        return direct(id, fn);
      },
    );

    await report("one");

    await report({ text: "two", kind: "result" });

    expect(main.posts).toEqual([
      { text: "one" },
      { text: "two", kind: "result" },
    ]);

    expect(ids).toEqual(["report:1:0:main", "report:2:0:main"]);
  });

  test("with no main channel and no config it does nothing", async () => {
    const report = createReporter({}, undefined, direct);

    await expect(report("quiet")).resolves.toBeUndefined();
  });

  test("config and `to` choose names or inline channels; a wrong name throws", async () => {
    const a = recorder();
    const b = recorder();
    const c = recorder();
    const channels = { a: a.channel, b: b.channel };

    const report = createReporter(channels, ["a", c.channel], direct);

    await report("x");

    await report("y", { to: "b" });

    expect(
      a.posts.map((m) => {
        return m.text;
      }),
    ).toEqual(["x"]);

    expect(
      c.posts.map((m) => {
        return m.text;
      }),
    ).toEqual(["x"]);

    expect(
      b.posts.map((m) => {
        return m.text;
      }),
    ).toEqual(["y"]);

    await expect(report("z", { to: "nope" })).rejects.toThrow(
      'no channel named "nope"',
    );

    await expect(
      createReporter(channels, "missing", direct)("z"),
    ).rejects.toThrow('no channel named "missing"');
  });
});

describe("report validation", () => {
  test("a wrong name fails before any destination is posted to", async () => {
    const a = recorder();

    const report = createReporter({ a: a.channel }, ["a", "missing"], direct);

    await expect(report("x")).rejects.toThrow('no channel named "missing"');

    expect(a.posts).toEqual([]);
  });

  test("a null thread_ts is rejected, so the key and the target agree", () => {
    expect(() => {
      return slack.channel({
        data: { channel: "C1", ts: "1.1", text: "hi", thread_ts: null },
      });
    }).toThrow("thread_ts");
  });

  test("a Slack message with a null user is accepted", () => {
    expect(() => {
      return slack.channel({
        data: { channel: "C1", ts: "1.1", text: "hi", user: null },
      });
    }).not.toThrow();
  });
});

describe("trigger helpers", () => {
  test("slack.thread keys by channel and thread timestamp", () => {
    const trigger = slack.thread({ in: ["C1", "C2"] });

    expect(trigger.event).toBe("slack/message");

    expect(trigger.if).toBe(
      '(event.data.channel == "C1" || event.data.channel == "C2")',
    );

    expect(trigger.thread).toContain("has(event.data.thread_ts)");
    expect(trigger.message({ data: { text: "hi" } })).toBe("hi");

    expect(slack.thread().if).toBeUndefined();
  });

  test("github.comment rejects a repository that is not owner/repo", () => {
    expect(() => {
      return github.comment({ repos: ["acme"] });
    }).toThrow("not an");
  });

  test("github.comment keys by repository and number", () => {
    const trigger = github.comment({ repos: ["acme/app"] });

    expect(trigger.event).toBe("github/issue_comment");

    expect(trigger.if).toBe(
      '((event.data.owner == "acme" && event.data.repo == "app"))',
    );

    expect(trigger.thread).toContain('#" + event.data.number');
  });
});

describe("adapters", () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];

  beforeEach(() => {
    calls.length = 0;

    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("slack.channel posts and asks in the event's thread", async () => {
    const channel = slack.channel(
      { data: { channel: "C1", ts: "1.1", text: "hi" } },
      { apiUrl: "http://slack.test" },
    );

    await channel.post({ text: "working" });

    await channel.ask?.({
      signal: "sig",
      question: "go?",
      options: ["yes", "no"],
    });

    expect(calls[0]).toEqual({
      url: "http://slack.test/chat.postMessage",
      body: { channel: "C1", thread_ts: "1.1", text: "working" },
    });

    expect(calls[1]?.body.thread_ts).toBe("1.1");

    expect(JSON.stringify(calls[1]?.body.blocks)).toContain('"value":"yes"');
  });

  test("slack ask shows the timeout and uses a menu past 25 options", async () => {
    const channel = slack.channel(
      { channel: "C1", thread_ts: "1.1" },
      { apiUrl: "http://slack.test" },
    );

    const many = Array.from({ length: 30 }, (_, i) => {
      return `o${i}`;
    });

    await channel.ask?.({
      signal: "s",
      question: "q",
      options: ["a"],
      timeout: "7d",
    });

    await channel.ask?.({ signal: "s", question: "q", options: many });

    expect(JSON.stringify(calls[0]?.body.blocks)).toContain(
      "Answer within 7d.",
    );

    expect(JSON.stringify(calls[0]?.body.blocks)).toContain('"type":"button"');
    expect(JSON.stringify(calls[1]?.body.blocks)).toContain("static_select");

    expect(JSON.stringify(calls[1]?.body.blocks)).not.toContain(
      '"type":"button"',
    );

    await expect(
      channel.ask?.({
        signal: "s",
        question: "q",
        options: Array.from({ length: 101 }, String),
      }),
    ).rejects.toThrow("at most 100");
  });

  test("slack.channel rejects an event of the wrong shape", () => {
    expect(() => {
      return slack.channel({ data: { text: 1 } });
    }).toThrow("not a slack/message");
  });

  test("github.channel comments on the event's issue", async () => {
    const channel = github.channel(
      { data: { owner: "acme", repo: "app", number: "7", body: "b" } },
      { apiUrl: "http://gh.test" },
    );

    await channel.post({ text: "progress" });

    await channel.ask?.({ signal: "sig", question: "ok?", options: ["a"] });

    expect(calls[0]).toEqual({
      url: "http://gh.test/repos/acme/app/issues/7/comments",
      body: { body: "progress" },
    });

    expect(calls[1]?.body.body).toContain("<!-- inngest-ask:sig -->");
  });

  test("an empty allow-list is an error, not everything", () => {
    expect(() => {
      return slack.thread({ in: [] });

    }).toThrow("empty");
    expect(() => {
      return github.comment({ repos: [] });
    }).toThrow("empty");
  });

  test("github.channel rejects a number that is not a number", () => {
    expect(() => {
      return github.channel({
        data: { owner: "o", repo: "r", number: "abc", body: "b" },
      });
    }).toThrow("not an issue number");
  });

  test("github.channel checks a target's number too", () => {
    for (const number of [0, -1, 1.5, Number.NaN]) {
      expect(() => {
        return github.channel({ owner: "o", repo: "r", number });
      }).toThrow("not an issue number");
    }
  });

  test("a Slack menu option longer than Slack allows is an error", async () => {
    const channel = slack.channel({ channel: "C1", thread_ts: "1.1" });

    await expect(
      channel.ask?.({
        signal: "s",
        question: "q",
        options: Array.from({ length: 26 }, () => {
          return "x".repeat(151);
        }),
      }),
    ).rejects.toThrow("at most 150");
  });

  test("github.channel accepts only plain positive issue numbers", () => {
    for (const number of ["", " ", "1e1", "0x10", "-5", "0"]) {
      expect(() => {
        return github.channel({
          data: { owner: "o", repo: "r", number, body: "b" },
        });
      }).toThrow("not an issue number");
    }
  });

  test("an API failure throws", async () => {
    vi.stubGlobal("fetch", async () => {
      return new Response("{}", { status: 500 });
    });

    await expect(
      github.channel({ owner: "o", repo: "r", number: 1 }).post({ text: "x" }),
    ).rejects.toThrow("HTTP 500");
  });
});

describe("agent function wiring", () => {
  test("channels may be a function of the trigger and report reaches them", async () => {
    const main = recorder();
    const seen: string[] = [];

    const { fn } = createAgentFunction(
      new Inngest({ id: testClientId }),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        channels: ({ event }) => {
          seen.push(event.data.thread);

          return { main: main.channel };
        },
      },
      async ({ report, channels }) => {
        await report("starting");

        return Object.keys(channels);
      },
    );

    const result = await run(fn, {
      event: {
        name: "agent/message",
        data: { agent: `${testClientId}/bot`, thread: "t1", kind: "user" },
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(main.posts).toEqual([{ text: "starting" }]);

    expect(result).toBeDefined();
  });
});
