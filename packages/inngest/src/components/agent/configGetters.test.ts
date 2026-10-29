/**
 * @module
 * Tests for the config pieces that take a function for what a Worker only has
 * per request: a KV, and the tokens of the Slack and GitHub channels.
 */
import { Inngest } from "../Inngest.ts";
import { github } from "./github.ts";
import { createKv, kv, kvFrom, memoryKvAdapter } from "./kv.ts";
import { slack } from "./slack.ts";
import { getThread } from "./thread.ts";

describe("kvFrom", () => {
  test("a function is called at each use and every member follows it", async () => {
    const first = createKv({ adapter: memoryKvAdapter() });
    const second = createKv({ adapter: memoryKvAdapter() });
    let current = first;
    let calls = 0;
    const client = new Inngest({ id: "getter-app" });
    const lazy = kvFrom(() => {
      calls++;

      return current;
    });

    await lazy.with(client).env.set("k", 1);
    expect(await first.with(client).env.get("k")).toBe(1);

    current = second;
    await lazy.with(client).env.set("k", 2);

    expect(await first.with(client).env.get("k")).toBe(1);
    expect(await second.with(client).env.get("k")).toBe(2);
    expect(calls).toBe(2);
  });

  test("a value is returned as it is, and nothing is the default kv", () => {
    const own = createKv({ adapter: memoryKvAdapter() });

    expect(kvFrom(own)).toBe(own);
    expect(kvFrom(undefined)).toBe(kv);
    expect(
      (kvFrom(() => own) as unknown as { then?: unknown }).then,
    ).toBeUndefined();
  });

  test("a thread handle reads the thread state through a kv function", async () => {
    const mine = createKv({ adapter: memoryKvAdapter() });
    const client = new Inngest({ id: "getter-thread" });
    let asked = 0;

    await mine.with(client).scope("thread", "t1").set("note", "hello");
    const thread = getThread(client, "getter-thread/agent", "t1", {
      kv: () => {
        asked++;

        return mine;
      },
    });

    const state = await thread.state();

    expect(state.keys.note).toBe("hello");
    expect(asked).toBeGreaterThan(0);
  });
});

describe("channel tokens", () => {
  const sent: (string | undefined)[] = [];

  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal(
      "fetch",
      async (_url: string, init: { headers: Record<string, string> }) => {
        sent.push(init.headers.authorization);

        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("slack calls an async token function for every post, and a string still works", async () => {
    let n = 0;
    const channel = slack.channel(
      { data: { channel: "C1", ts: "1.1", text: "hi" } },
      {
        in: ["C1"],
        apiUrl: "http://slack.test",
        token: async () => {
          n++;

          return `xoxb-${n}`;
        },
      },
    );

    await channel.post({ text: "one" });
    await channel.post({ text: "two" });

    expect(sent).toEqual(["Bearer xoxb-1", "Bearer xoxb-2"]);

    await slack
      .channel(
        { data: { channel: "C1", ts: "1.1", text: "hi" } },
        { in: ["C1"], apiUrl: "http://slack.test", token: "xoxb-plain" },
      )
      .post({ text: "plain" });

    expect(sent.at(-1)).toBe("Bearer xoxb-plain");
  });

  test("github calls a token function for every comment, and a string still works", async () => {
    let n = 0;
    const event = {
      data: { owner: "acme", repo: "app", number: 7, body: "b" },
    };
    const channel = github.channel(event, {
      repos: ["acme/app"],
      apiUrl: "http://gh.test",
      token: () => {
        n++;

        return `ghs_${n}`;
      },
    });

    await channel.post({ text: "one" });
    await channel.post({ text: "two" });

    expect(sent).toEqual(["Bearer ghs_1", "Bearer ghs_2"]);

    await github
      .channel(event, {
        repos: ["acme/app"],
        apiUrl: "http://gh.test",
        token: "ghs_plain",
      })
      .post({ text: "plain" });

    expect(sent.at(-1)).toBe("Bearer ghs_plain");
  });
});
