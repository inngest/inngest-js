/**
 * @module
 * Tests for what a run leaves behind for its thread (`me.listen`,
 * `me.unlisten`, `me.wake`, `me.cancelWake`), the hidden functions behind them,
 * `me` in a tool's context, and `delivery: "queue"`.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { resolveToolCall, tool } from "../../../components/sandbox/tools.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgents } from "./agents.ts";
import { listenFunction, wakeFunction } from "./scheduling.ts";
import { freshKv, run } from "./test-helpers.ts";

type Sent = { name: string; id?: string; data: Record<string, unknown> };

const makeClient = () => {
  const client = new Inngest({ id: testClientId });
  const sent: Sent[] = [];

  Object.defineProperty(client, "_send", {
    value: async (input: { payload: unknown }) => {
      for (const event of [input.payload].flat()) {
        sent.push(event as Sent);
      }

      return { ids: [], status: 200 };
    },
  });

  return { client, sent };
};

const order = { name: "shop/order", data: { id: "t1" } };
const threadKey = "t1";

const optionsOf = (fn: { opts?: unknown }) => {
  return (fn as unknown as { ["opts"]: unknown })["opts"] as Record<
    string,
    unknown
  >;
};

describe("me.listen and me.unlisten", () => {
  test("listen sends the rule and keeps it in the thread's KV", async () => {
    const { client, sent } = makeClient();
    const store = freshKv().with(client);
    const agents = createAgents(client);
    const { fn } = agents.agent(
      {
        id: "watcher",
        triggers: [{ event: "shop/order", thread: "event.data.id" }],
      },
      async ({ me }) => {
        await me.listen("pr-42", {
          event: "github/pull_request",
          if: "async.data.pr == 42",
          ttl: "1h",
        });
      },
    );

    const { error } = await run(fn, { event: order });

    expect(error).toBeUndefined();
    expect(
      await store.scope("thread", threadKey).get("listen:pr-42"),
    ).toMatchObject({
      event: "github/pull_request",
      if: "async.data.pr == 42",
    });

    const listens = sent.filter((event) => {
      return event.name === "agent/thread.listen";
    });

    expect(listens).toHaveLength(1);
    expect(listens[0]?.data).toMatchObject({
      agent: `${testClientId}/watcher`,
      thread: threadKey,
      name: "pr-42",
      event: "github/pull_request",
      if: "async.data.pr == 42",
      id: expect.any(String),
    });
    expect(Date.parse(String(listens[0]?.data.until))).toBeGreaterThan(
      Date.now(),
    );
  });

  test("listen refuses a name that is not plain and a ttl that is not a duration", async () => {
    const { client } = makeClient();
    freshKv();
    const agents = createAgents(client);
    const failures = new Set<string>();
    const { fn } = agents.agent(
      {
        id: "watcher-bad",
        triggers: [{ event: "shop/order", thread: "event.data.id" }],
      },
      async ({ me }) => {
        await me.listen("has space", { event: "x" }).catch((error) => {
          failures.add(String(error.message));
        });
        await me.listen("ok", { event: "x", ttl: "soon" }).catch((error) => {
          failures.add(String(error.message));
        });
      },
    );

    await run(fn, { event: order });

    expect([...failures].some((m) => m.includes("letters, digits"))).toBe(true);
    expect([...failures].some((m) => m.includes("ttl"))).toBe(true);
  });

  test("unlisten sends the matching event, and listening again replaces the rule", async () => {
    const { client, sent } = makeClient();
    freshKv();
    const agents = createAgents(client);
    const { fn } = agents.agent(
      {
        id: "watcher-replace",
        triggers: [{ event: "shop/order", thread: "event.data.id" }],
      },
      async ({ me }) => {
        await me.listen("a", { event: "x" });
        await me.listen("a", { event: "y" });
        await me.unlisten("a");
      },
    );

    await run(fn, { event: order });

    expect(
      sent.map((event) => {
        return event.name;
      }),
    ).toEqual([
      "agent/thread.listen",
      "agent/thread.listen",
      "agent/thread.unlisten",
    ]);
    // The second listen names the first, which its run cancels once it listens.
    expect(sent[1]?.data).toMatchObject({
      name: "a",
      replaces: sent[0]?.data.id,
    });
    expect(sent[2]?.data).toMatchObject({ thread: threadKey, name: "a" });
  });
});

describe("me.wake and me.cancelWake", () => {
  test("each arming of a name has its own id, and a cancel names the latest", async () => {
    const { client, sent } = makeClient();
    freshKv();
    const agents = createAgents(client);
    const { fn } = agents.agent(
      {
        id: "waker",
        triggers: [{ event: "shop/order", thread: "event.data.id" }],
      },
      async ({ me }) => {
        await me.wake("check", "30s");
        await me.cancelWake("check");
        await me.wake("check", "30s");
        await me.cancelWake("never-armed");
      },
    );

    await run(fn, { event: order });

    const names = sent.map((event) => {
      return event.name;
    });

    expect(names).toEqual([
      "agent/thread.wake",
      "agent/thread.cancelWake",
      "agent/thread.wake",
    ]);

    const [first, cancel, second] = sent;

    expect(first?.data.id).not.toBe(second?.data.id);
    expect(cancel?.data.id).toBe(first?.data.id);
    expect(cancel?.data).toMatchObject({ thread: threadKey, name: "check" });
  });
});

describe("the hidden functions", () => {
  test("agents-listen is cancelled by the unlisten of its thread and name", () => {
    const { client } = makeClient();
    const fn = listenFunction(client);

    expect(optionsOf(fn).id).toBe("agents-listen");
    expect(optionsOf(fn).cancelOn).toEqual([
      {
        event: "agent/thread.unlisten",
        if: expect.stringContaining("async.data.thread == event.data.thread"),
      },
      {
        event: "agent/thread.cancelListen",
        if: expect.stringContaining("async.data.id == event.data.id"),
      },
    ]);
    expect((optionsOf(fn).cancelOn as { if: string }[])[0]?.if).toContain(
      "async.data.name == event.data.name",
    );
  });

  test("agents-wake is cancelled only by a cancel with its own id", () => {
    const { client } = makeClient();
    const fn = wakeFunction(client);

    expect(optionsOf(fn).id).toBe("agents-wake");
    expect((optionsOf(fn).cancelOn as { if: string }[])[0]?.if).toContain(
      "async.data.id == event.data.id",
    );
  });

  test("agents-wake sleeps, clears its mirror and messages the thread", async () => {
    const { client, sent } = makeClient();
    const store = freshKv().with(client);

    await store.scope("thread", threadKey).set("wake:check", {
      id: "w1",
      after: "30s",
    });

    const { error } = await run(wakeFunction(client), {
      event: {
        name: "agent/thread.wake",
        data: {
          agent: `${testClientId}/watcher`,
          thread: threadKey,
          name: "check",
          after: "30s",
          id: "w1",
        },
      },
    });

    expect(error).toBeUndefined();
    expect(
      await store.scope("thread", threadKey).get("wake:check"),
    ).toBeFalsy();
    expect(sent).toMatchObject([
      {
        name: "agent/message",
        id: "wake:w1",
        data: {
          agent: `${testClientId}/watcher`,
          thread: threadKey,
          content: { wake: { name: "check", at: expect.any(String) } },
          from: { wake: "check" },
        },
      },
    ]);
  });
});

describe("me in a tool's context", () => {
  test("a tool outside an agent run cannot read it", async () => {
    let problem = "";
    const probe = tool.group({
      description: { does: "reads me" },
      run: async (_input: unknown, ctx) => {
        try {
          return ctx.me.key;
        } catch (error) {
          problem = (error as Error).message;

          return "";
        }
      },
    });
    const resolved = await resolveToolCall(
      { probe },
      { op: "call", id: 1, tool: "probe", args: [], kwargs: {} },
      "{}",
    );

    if (resolved.error !== undefined) {
      throw new Error(resolved.error);
    }

    await resolved.invoke({
      signal: new AbortController().signal,
      idempotencyKey: "k",
    });

    expect(problem).toContain("agent run");
  });
});

describe('delivery: "queue"', () => {
  const config = {
    triggers: [{ event: "shop/order", thread: "event.data.id" }],
  };

  test("queue is the singleton's mode", () => {
    const { client } = makeClient();
    const agents = createAgents(client);
    const queued = optionsOf(
      agents.agent({ id: "q1", ...config, delivery: "queue" }).fn,
    );
    const skipping = optionsOf(agents.agent({ id: "q2", ...config }).fn);

    expect(queued.singleton).toMatchObject({ mode: "queue" });
    expect(skipping.singleton).toMatchObject({ mode: "skip" });
  });

  test("a delivery that is not known is refused", () => {
    const { client } = makeClient();
    const agents = createAgents(client);

    expect(() => {
      agents.agent({
        id: "q4",
        ...config,
        delivery: "later" as unknown as "queue",
      });
    }).toThrow(/delivery/);
  });
});
