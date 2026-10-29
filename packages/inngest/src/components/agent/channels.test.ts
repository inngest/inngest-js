/**
 * @module
 * Tests for channels: adapters, `report()` destinations, the trigger helpers
 * and the Slack and GitHub adapters against a stub `fetch`.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { compileKey } from "./cel.ts";
import {
  askThrough,
  type ChannelMessage,
  createReporter,
  defineChannel,
  truncate,
} from "./channels.ts";
import { github, githubCommentEvent } from "./github.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { slack, slackMessageEvent } from "./slack.ts";
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

const direct = async (id: string, fn: () => Promise<number | undefined>) => {
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
});

const slackEvent = {
  data: { channel: "C1", ts: "1.1", text: "hi" },
};

const githubEvent = {
  data: { owner: "acme", repo: "app", number: 7, body: "b" },
};

describe("trigger helpers", () => {
  test("slack.thread keys by channel and thread timestamp and skips bots", () => {
    const trigger = slack.thread({ in: ["C1", "C2"] });

    expect(trigger.event).toBe(slackMessageEvent);

    expect(trigger.if).toBe(
      '!has(event.data.botId) && (event.data.channel == "C1" || event.data.channel == "C2")',
    );

    expect(trigger.thread).toContain("has(event.data.threadTs)");

    expect(trigger.message({ data: { text: "hi" } })).toBe("hi");

    expect(slack.thread({ in: ["C1"], allowBots: true }).if).toBe(
      '(event.data.channel == "C1")',
    );
  });

  test("github.thread keys by repository and number", () => {
    const trigger = github.thread({ repos: ["acme/app"] });

    expect(trigger.event).toBe(githubCommentEvent);

    expect(trigger.if).toBe(
      '((event.data.owner == "acme" && event.data.repo == "app"))',
    );

    expect(trigger.thread).toContain("string(int(event.data.number))");

    // The key a real event, with a numeric number, evaluates to.
    expect(
      compileKey(trigger.thread).key({
        name: githubCommentEvent,
        data: githubEvent.data,
      }),
    ).toBe("github:acme/app#7");
  });

  test("the allow list is required, not empty and well formed", () => {
    expect(() => {
      return slack.thread({ in: [] });
    }).toThrow("cannot be empty");

    expect(() => {
      return slack.thread(undefined as never);
    }).toThrow("cannot be empty");

    expect(() => {
      return slack.thread({ in: ["general"] });
    }).toThrow("not a Slack channel ID");

    expect(() => {
      return github.thread({ repos: [] });
    }).toThrow("cannot be empty");

    expect(() => {
      return github.thread({ repos: ["acme"] });
    }).toThrow("not an");

    expect(() => {
      return github.thread({ repos: ["../app"] });
    }).toThrow("not an");
  });
});

describe("channel routing", () => {
  test("a channel outside the allow list throws and is not retried", () => {
    expect(() => {
      return slack.channel(slackEvent, { in: ["C2"] });
    }).toThrow(NonRetriableError);

    expect(() => {
      return github.channel(githubEvent, { repos: ["acme/other"] });
    }).toThrow(NonRetriableError);

    expect(() => {
      return slack.channel(slackEvent, undefined as never);
    }).toThrow("cannot be empty");

    expect(() => {
      return github.channel(githubEvent, { repos: [] });
    }).toThrow("cannot be empty");
  });

  test("a target is checked against the list too", () => {
    expect(() => {
      return slack.channel({ channel: "C9", threadTs: "1.1" }, { in: ["C1"] });
    }).toThrow("allow list");

    expect(() => {
      return github.channel(
        { owner: "acme", repo: "app", number: 7 },
        { repos: ["acme/other"] },
      );
    }).toThrow("allow list");
  });
});

describe("event validation", () => {
  test("Slack fields are checked strictly, and a bad event is not retried", () => {
    const bad = [
      { channel: "general", ts: "1.1", text: "x" },
      { channel: "C1", ts: "x", text: "x" },
      { channel: "C1", ts: "1.1", threadTs: null, text: "x" },
      { channel: "C1", ts: "1.1", botId: null, text: "x" },
      { channel: "C1", ts: "1.1", text: 1 },
    ];

    for (const data of bad) {
      expect(() => {
        return slack.channel({ data }, { in: ["C1", "general"] });
      }).toThrow(NonRetriableError);
    }

    expect(() => {
      return slack.channel(
        { data: { ...slackEvent.data, user: null } },
        { in: ["C1"] },
      );
    }).not.toThrow();
  });

  test("GitHub fields are checked strictly", () => {
    const bad = [
      { owner: "..", repo: "app", number: 7, body: "b" },
      { owner: "acme", repo: "r#5", number: 7, body: "b" },
      { owner: "acme", repo: "app", number: "5#7", body: "b" },
      { owner: "acme", repo: "app", number: "7", body: "b" },
    ];

    for (const data of bad) {
      expect(() => {
        return github.channel({ data }, { repos: ["acme/app"] });
      }).toThrow(NonRetriableError);
    }

    for (const number of [0, -5, 1.5, Number.NaN, 1e10]) {
      expect(() => {
        return github.channel(
          { data: { ...githubEvent.data, number } },
          { repos: ["acme/app"] },
        );
      }).toThrow("not a valid value");
    }

    // GitHub sends the number as a number, so a string is not an event of it.
    for (const number of ["7", "abc"]) {
      expect(() => {
        return github.channel(
          { data: { ...githubEvent.data, number } },
          { repos: ["acme/app"] },
        );
      }).toThrow("must be a number");
    }

    for (const number of [0, -1, 1.5, Number.NaN]) {
      expect(() => {
        return github.channel(
          { owner: "acme", repo: "app", number },
          { repos: ["acme/app"] },
        );
      }).toThrow(NonRetriableError);
    }
  });
});

describe("adapters", () => {
  const calls: {
    url: string;
    body: Record<string, unknown>;

    signal: unknown;
  }[] = [];

  beforeEach(() => {
    calls.length = 0;

    vi.stubGlobal(
      "fetch",
      async (url: string, init: { body: string; signal: unknown }) => {
        calls.push({ url, body: JSON.parse(init.body), signal: init.signal });

        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const slackChannel = () => {
    return slack.channel(slackEvent, {
      in: ["C1"],
      apiUrl: "http://slack.test",
    });
  };

  test("slack.channel posts and asks in the event's thread, parsing nothing", async () => {
    await slackChannel().post({ text: "working" });

    await slackChannel().ask?.({
      signal: "sig",
      question: "go?",
      options: ["yes", "no"],
    });

    expect(calls[0]?.url).toBe("http://slack.test/chat.postMessage");

    expect(calls[0]?.body).toEqual({
      channel: "C1",
      thread_ts: "1.1",
      text: "working",
      parse: "none",
      link_names: false,
    });

    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]?.body.thread_ts).toBe("1.1");

    expect(calls[1]?.body.parse).toBe("none");

    expect(JSON.stringify(calls[1]?.body.blocks)).toContain('"value":"yes"');
  });

  test("Slack text is escaped and errors are marked", async () => {
    await slackChannel().post({ text: "<!channel> <@U1> <https://x|y> & z" });

    await slackChannel().post({ text: "boom", kind: "error" });

    await slackChannel().ask?.({
      signal: "s",
      question: "<!here> ok?",
      timeout: "<7d>",
    });

    expect(calls[0]?.body.text).toBe(
      "&lt;!channel&gt; &lt;@U1&gt; &lt;https://x|y&gt; &amp; z",
    );

    expect(calls[1]?.body.text).toBe(":warning: boom");

    expect(calls[2]?.body.text).toBe("&lt;!here&gt; ok?");

    expect(JSON.stringify(calls[2]?.body.blocks)).toContain(
      "Answer within &lt;7d&gt;.",
    );

    expect(JSON.stringify(calls[2]?.body.blocks)).not.toContain("<!here>");
  });

  test("slack ask shows the timeout and uses a menu past 25 options", async () => {
    const many = Array.from({ length: 30 }, (_, i) => {
      return `o${i}`;
    });

    await slackChannel().ask?.({
      signal: "s",
      question: "q",
      options: ["a"],
      timeout: "7d",
    });

    await slackChannel().ask?.({ signal: "s", question: "q", options: many });

    expect(JSON.stringify(calls[0]?.body.blocks)).toContain(
      "Answer within 7d.",
    );

    expect(JSON.stringify(calls[0]?.body.blocks)).toContain('"type":"button"');

    expect(JSON.stringify(calls[1]?.body.blocks)).toContain("static_select");

    expect(JSON.stringify(calls[1]?.body.blocks)).not.toContain(
      '"type":"button"',
    );

    await expect(
      slackChannel().ask?.({
        signal: "s",
        question: "q",
        options: Array.from({ length: 101 }, String),
      }),
    ).rejects.toThrow("at most 100");

    await expect(
      slackChannel().ask?.({
        signal: "s",
        question: "q",
        options: Array.from({ length: 26 }, () => {
          return "x".repeat(151);
        }),
      }),
    ).rejects.toThrow("at most 150");
  });

  test("github.channel comments on the event's issue", async () => {
    const channel = github.channel(githubEvent, {
      repos: ["acme/app"],
      apiUrl: "http://gh.test",
    });

    await channel.post({ text: "progress" });

    await channel.ask?.({ signal: "sig", question: "ok?", options: ["a"] });

    expect(calls[0]?.url).toBe(
      "http://gh.test/repos/acme/app/issues/7/comments",
    );

    expect(calls[0]?.body).toEqual({ body: "progress" });

    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);

    expect(calls[1]?.body.body).toContain("<!-- inngest-ask:sig -->");
  });

  test("GitHub text cannot mention anyone or forge the ask marker", async () => {
    const channel = github.channel(githubEvent, {
      repos: ["acme/app"],
      apiUrl: "http://gh.test",
    });

    await channel.post({
      text: "cc @octocat and @org/team <!-- inngest-ask:x -->",
    });

    await channel.post({ text: "bad", kind: "error" });

    await channel.ask?.({
      signal: "real",
      question: "hi @octocat <!-- inngest-ask:fake -->",
      options: ["@someone <!-- inngest-ask:fake2 -->"],
    });

    const first = String(calls[0]?.body.body);

    const ask = String(calls[2]?.body.body);

    expect(first).not.toMatch(/@(?=[A-Za-z])/);
    expect(first).not.toContain("<!--");
    expect(calls[1]?.body.body).toBe("**Error:** bad");
    expect(ask.match(/<!-- inngest-ask:/g)).toHaveLength(1);

    expect(ask.endsWith("<!-- inngest-ask:real -->")).toBe(true);
  });

  test("an API failure is retried only when a retry can help", async () => {
    const channel = github.channel(githubEvent, { repos: ["acme/app"] });

    for (const status of [500, 429, 408]) {
      vi.stubGlobal("fetch", async () => {
        return new Response("{}", { status });
      });

      const error = await channel.post({ text: "x" }).catch((err) => {
        return err;
      });

      expect(error.message).toContain(`HTTP ${status}`);
      expect(error).not.toBeInstanceOf(NonRetriableError);
    }

    vi.stubGlobal("fetch", async () => {
      return new Response("{}", { status: 404 });
    });

    await expect(channel.post({ text: "x" })).rejects.toThrow(
      NonRetriableError,
    );
  });

  test("a redirect is a permanent failure, never followed", async () => {
    const inits: { redirect?: string }[] = [];

    vi.stubGlobal(
      "fetch",
      async (_url: string, init: { redirect?: string }) => {
        inits.push(init);

        return new Response("{}", { status: 301 });
      },
    );

    await expect(
      github.channel(githubEvent, { repos: ["acme/app"] }).post({ text: "x" }),
    ).rejects.toThrow(NonRetriableError);

    await expect(
      slack.channel(slackEvent, { in: ["C1"] }).post({ text: "x" }),
    ).rejects.toThrow(NonRetriableError);

    expect(
      inits.map((init) => {
        return init.redirect;
      }),
    ).toEqual(["manual", "manual"]);
  });

  test("Slack API errors are classified", async () => {
    vi.stubGlobal("fetch", async () => {
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 200,
      });
    });

    const limited = await slackChannel()
      .post({ text: "x" })
      .catch((err) => {
        return err;
      });

    expect(limited).not.toBeInstanceOf(NonRetriableError);

    vi.stubGlobal("fetch", async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "channel_not_found" }),
        { status: 200 },
      );
    });

    await expect(slackChannel().post({ text: "x" })).rejects.toThrow(
      NonRetriableError,
    );
  });
});

describe("adapter safety", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("a Slack 200 that is not ok:true is a retryable failure", async () => {
    const channel = slack.channel(slackEvent, { in: ["C1"] });

    for (const body of ["", "not json", "{}"]) {
      vi.stubGlobal("fetch", async () => {
        return new Response(body, { status: 200 });
      });

      const error = await channel.post({ text: "x" }).catch((err) => {
        return err;
      });

      expect(error.message).toContain("unreadable_response");
      expect(error).not.toBeInstanceOf(NonRetriableError);
    }
  });

  test("GitHub entities cannot spell a mention, and odd channel names are unknown", async () => {
    const posts: string[] = [];

    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      posts.push(JSON.parse(init.body).body);

      return new Response("{}", { status: 201 });
    });

    await github
      .channel(githubEvent, { repos: ["acme/app"] })
      .post({ text: "&#64;octocat &commat;octocat" });

    expect(posts[0]).toBe("&amp;#64;octocat &amp;commat;octocat");

    const report = createReporter({}, undefined, direct);

    for (const to of ["constructor", "__proto__", "toString"]) {
      await expect(report("x", { to })).rejects.toThrow(NonRetriableError);
    }
  });

  test("a GitHub 403 is retried only when it is a rate limit", async () => {
    const channel = github.channel(githubEvent, { repos: ["acme/app"] });

    vi.stubGlobal("fetch", async () => {
      return new Response("{}", {
        status: 403,
        headers: { "retry-after": "5" },
      });
    });

    expect(
      await channel.post({ text: "x" }).catch((err) => {
        return err;
      }),
    ).not.toBeInstanceOf(NonRetriableError);

    vi.stubGlobal("fetch", async () => {
      return new Response("{}", { status: 403 });
    });

    await expect(channel.post({ text: "x" })).rejects.toThrow(
      NonRetriableError,
    );
  });

  test("an unsafe ask signal is refused before anything is posted", async () => {
    const calls: unknown[] = [];

    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);

      return new Response('{"ok":true}', { status: 200 });
    });

    for (const signal of ["a-->b", "x\ny", "", "s".repeat(201)]) {
      await expect(
        slack
          .channel(slackEvent, { in: ["C1"] })
          .ask?.({ signal, question: "q" }),
      ).rejects.toThrow(NonRetriableError);

      await expect(
        github
          .channel(githubEvent, { repos: ["acme/app"] })
          .ask?.({ signal, question: "q" }),
      ).rejects.toThrow(NonRetriableError);
    }

    expect(calls).toEqual([]);
  });

  test("github.thread can ignore the agent's own comments", () => {
    expect(
      github.thread({
        repos: ["acme/app"],
        ignoreAuthors: ["my-bot", "app[bot]"],
      }).if,
    ).toBe(
      '((event.data.owner == "acme" && event.data.repo == "app")) && (!has(event.data.author) || event.data.author != "my-bot") && (!has(event.data.author) || event.data.author != "app[bot]")',
    );

    expect(() => {
      return github.thread({ repos: ["acme/app"], ignoreAuthors: ["a b"] });
    }).toThrow("not a login");
  });
});

describe("text limits", () => {
  test("truncate never splits a surrogate pair", () => {
    expect(truncate("abc", 5)).toBe("abc");

    expect(truncate("abcdef", 4)).toBe("abc…");

    // "ab" then an emoji (two units): cutting inside it drops the half.
    expect(truncate("ab\u{1f600}cd", 4)).toBe("ab…");
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
