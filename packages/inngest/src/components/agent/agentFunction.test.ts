/**
 * @module
 * Tests for the agent function body against a fake executor.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { Middleware } from "../middleware/middleware.ts";
import { eventType, invoke, staticSchema } from "../triggers/triggers.ts";
import type { ThreadInbox } from "./agentFunction.ts";
import {
  type AgentFunctionConfig,
  createAgentFunction,
} from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import { sandbox } from "./defs.ts";
import { agentMessage } from "./events.ts";
import { invokeAgent } from "./invoke.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { type AgentModelResponse, agent, type ModelMessage } from "./loop.ts";
import { run, textOf } from "./test-helpers.ts";

const say = (text: string): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
  };
};

const message = (
  kind: "user" | "steer",
  content?: string,
  thread = "t1",
  extra: Record<string, unknown> = {},
) => {
  const routing = { agent: `${testClientId}/bot`, thread };
  const { id, ts, ...data } = extra;
  const carried = {
    ...(id !== undefined && { id }),
    ...(ts !== undefined && { ts }),
  };

  switch (kind) {
    case "steer":
      return {
        name: "agent/steer",
        ...carried,
        data: { ...routing, text: content, ...data },
      };
    default:
      return {
        name: "agent/message",
        ...carried,
        data: { ...routing, text: content, ...data },
      };
  }
};

const trigger = (content: string) => {
  return message("user", content);
};

const makeClient = () => {
  return new Inngest({ id: testClientId });
};

const userTexts = (messages: { role: string; content?: unknown }[]) => {
  return messages.flatMap((m) => {
    return m.role === "user" ? [m.content] : [];
  });
};

describe("agent function", () => {
  test("is addressed as appId/functionId and starts on its own non-stop messages", () => {
    const { fn, ref } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async () => {},
    );

    expect(ref).toBe(`${testClientId}/bot`);
    const config = fn["opts"] as {
      singleton: unknown;
      triggers: { event: string; if: string }[];
    };
    expect(config.singleton).toEqual({
      key: "event.data.thread",
      mode: "skip",
    });
    expect(config.triggers.map((t) => t.event)).toEqual([
      "agent/message",
      "agent/steer",
    ]);
    expect(config.triggers[0]?.if).toContain(`"${testClientId}/bot"`);
  });

  test("the trigger is message 0, later messages are turns, and the conversation carries across turns", async () => {
    const prompts: unknown[][] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox, control }) => {
        let history: ModelMessage[] = [];
        let last = "";
        let n = -1;

        for await (const m of inbox) {
          n += 1;

          const result = await agent.loop({
            id: `turn${n}`,
            model: agent.model(async (request) => {
              prompts.push(userTexts(request.messages));

              return say(`ok ${n}`);
            }),
            prompt: m,
            tools: {},
            history,
            ...control,
          });
          history = result.history;
          last = result.text;

          if (n === 2) {
            break;
          }
        }

        return last;
      },
    );

    const { output } = await run(fn, {
      event: trigger("one"),
      saved: [message("user", "two"), message("user", "three")],
    });

    expect(output).toBe("ok 2");
    expect(prompts).toEqual([["one"], ["one", "two"], ["one", "two", "three"]]);
  });

  test("an inbox message is the event as it came", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const first = await inbox.next();
        const second = await inbox.next();

        return [first, second].map((m) => {
          return {
            name: m?.name,
            text: textOf(m),
            extra: m
              ? Object.keys(m).filter((key) => {
                  return !["data", "id", "name", "ts", "user"].includes(key);
                })
              : null,
            isMessage: m?.is(agentMessage),
          };
        });
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [message("steer", "left")],
    });

    expect(output).toEqual([
      {
        name: "agent/message",
        text: "go",
        extra: [],
        isMessage: true,
      },
      {
        name: "agent/steer",
        text: "left",
        extra: [],
        isMessage: false,
      },
    ]);
  });

  test("a thread message made from a trigger event (sent again by recovery) is that event", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        await inbox.next();
        const again = await inbox.next();

        return [again?.name, again?.id, again?.data];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [
        message("user", undefined, "t1", {
          event: { id: "evt9", name: "chat/message", data: { text: "hi" } },
        }),
      ],
    });

    expect(output).toEqual(["chat/message", "evt9", { text: "hi" }]);
  });

  test("an invoke of a plain agent with { agent, thread, text } is message 1, an agent/message", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const first = await inbox.next();

        return [first?.name, first?.data];
      },
    );

    const { output } = await run(fn, {
      event: {
        name: "inngest/function.invoked",
        data: {
          agent: `${testClientId}/bot`,
          thread: "t1",
          text: "go",
          _agent: { depth: 1 },
        },
      },
    });

    expect(output).toEqual([
      "agent/message",
      { agent: `${testClientId}/bot`, thread: "t1", text: "go" },
    ]);
  });
});

describe("inbox arrival", () => {
  const loopOnce = (seen: unknown[][]) => {
    return agent.model(async (request) => {
      seen.push(userTexts(request.messages));

      // The first call asks for a tool, so a second call follows and folds in
      // what arrived meanwhile; the second one ends the loop.
      return {
        message: { role: "assistant", content: [] },
        toolCalls:
          seen.length === 1 ? [{ id: "c1", name: "missing", input: {} }] : [],
      };
    });
  };

  test("agent.loop steers through the inbox without the app spreading control", async () => {
    const seen: unknown[][] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const first = await inbox.next();

        // No `...control`: the loop finds the inbox itself.
        const result = await agent.loop({
          model: loopOnce(seen),
          prompt: first ?? "",
          tools: {},
        });
        const next = await inbox.next();

        return [result.stopped, result.turns, textOf(next)];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [message("steer", "left"), message("user", "next")],
    });

    expect(seen).toEqual([["go"], ["go", "left"]]);
    expect(output).toEqual(["done", 2, "next"]);
  });

  test("foldMessages: all folds a user message into the turn, and next() does not return it again", async () => {
    const seen: unknown[][] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        foldMessages: "all",
      },
      async ({ inbox }) => {
        const first = await inbox.next();
        await agent.loop({
          model: agent.model(async (request) => {
            seen.push(userTexts(request.messages));

            // The second call has the folded message in its prompt.
            return userTexts(request.messages).length > 1
              ? say("done")
              : {
                  message: { role: "assistant", content: [] },
                  toolCalls: [{ id: "c1", name: "missing", input: {} }],
                };
          }),
          prompt: first ?? "",
          tools: {},
        });

        return (await inbox.next({ timeout: "1s" })) ?? "nothing left";
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [message("user", "also this")],
      timeouts: 1,
    });

    expect(seen).toEqual([["go"], ["go", "also this"]]);
    expect(output).toBe("nothing left");
  });

  test("inbox.drain() takes the pending messages, and next() does not return them again", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        await inbox.next();
        const drained = await inbox.drain();
        const after = await inbox.next({ timeout: "1s" });

        return [
          drained.map((m: { name: string }) => {
            return m.name;
          }),
          after,
        ];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [message("user", "a"), message("steer", "b")],
      timeouts: 1,
    });

    expect(output).toEqual([["agent/message", "agent/steer"], null]);
  });
});

describe("inbox sources", () => {
  const ci = (state: string) => {
    return { name: "ci/status", data: { t: "t1", state }, stream: 4 };
  };

  test("a configured source maps to the thread and its events are user messages for the model", async () => {
    const filters: unknown[] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        inbox: [
          {
            event: "ci/status",
            thread: "event.data.t",
            if: 'async.data.state != "ok"',
          },
          {
            event: "deploy/done",
            thread: "event.data.t",
          },
        ],
      },
      async ({ inbox }) => {
        await inbox.next();
        const red = await inbox.next();
        const deployed = await inbox.next();

        return [red?.name, red?.data, deployed?.name, deployed?.data];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      incoming: [
        ci("red"),
        { name: "deploy/done", data: { t: "t1", v: "1.2" } },
      ],
      onOp: (op) => {
        const opts = op.opts as
          | { sources?: { event: string; if?: string }[] }
          | undefined;

        for (const source of opts?.sources ?? []) {
          if (source.event === "ci/status" || source.event === "deploy/done") {
            filters.push([source.event, source.if]);
          }
        }
      },
    });

    expect(output).toEqual([
      "ci/status",
      { t: "t1", state: "red" },
      "deploy/done",
      { t: "t1", v: "1.2" },
    ]);
    // The filter is over `async` and ties the source to the run's thread.
    expect(filters).toContainEqual([
      "ci/status",
      '(async.data.state != "ok") && (async.data.t) == "t1"',
    ]);
    expect(filters).toContainEqual(["deploy/done", '(async.data.t) == "t1"']);
  });

  test("a source's events are checked against its event type, and ones that break it are dropped", async () => {
    const status = eventType("ci/typed", {
      schema: z.object({ state: z.string() }),
    });
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        inbox: [{ event: status, thread: "event.data.t" }],
      },
      async ({ inbox }) => {
        await inbox.next();
        const kept = await inbox.next();

        return kept ? { event: kept.name, data: kept.data } : null;
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      incoming: [
        {
          id: "typed-bad",
          name: "ci/typed",
          data: { t: "t1", state: 7 },
          stream: 4,
        },
        {
          id: "typed-ok",
          name: "ci/typed",
          data: { t: "t1", state: "green" },
          stream: 4,
        },
      ],
    });

    expect(output).toEqual({
      event: "ci/typed",
      data: { t: "t1", state: "green" },
    });
  });

  test("every source is one subscribe of the handler's inbox: the run's own messages and the definition's sources, and no listen op", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        inbox: [{ event: "ci/status", thread: "event.data.t" }],
      },
      async ({ inbox }) => {
        await inbox.next();

        return (await inbox.next())?.name;
      },
    );

    const { output, ops } = await run(fn, {
      event: trigger("go"),
      incoming: [ci("red")],
    });

    expect(output).toBe("ci/status");

    const opens = ops.filter((op) => {
      return (op.opts as { sources?: unknown } | undefined)?.sources;
    });

    expect(opens).toHaveLength(1);
    expect(
      (opens[0]?.opts as { sources: { event: string }[] }).sources.map((s) => {
        return s.event;
      }),
    ).toEqual(["agent/message", "agent/steer", "ci/status"]);
  });

  test("inbox_listen opens a named inbox: one subscribe whose if is over the arriving event", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        inboxTools: {
          listen: [{ event: "ci/status", thread: "event.data.t" }],
        },
      },
      async ({ inbox, inboxTools, control }) => {
        await inbox.next();
        await (
          inboxTools.inbox_listen?.run as unknown as (
            input: unknown,
          ) => Promise<unknown>
        )({
          source: "ci/status",
          match: { "data.state": "red" },
          as: "ci",
        });

        return control.inboxes().map((open) => {
          return [open.as, open.source];
        });
      },
    );

    const { output, ops } = await run(fn, { event: trigger("go") });

    expect(output).toEqual([
      [
        "ci",
        {
          event: "ci/status",
          if: '((async.data.state == "red")) && (async.data.t) == "t1"',
        },
      ],
    ]);
    expect(
      ops.some((op) => {
        return (
          op.opts as { sources?: { event: string }[] } | undefined
        )?.sources?.some((source) => {
          return source.event === "ci/status";
        });
      }),
    ).toBe(true);
  });

  test("the first read returns the trigger from state, and still draws its row at no step cost", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const first = await inbox.next();
        const second = await inbox.next();

        return [first?.name, second?.name];
      },
    );

    const { output, ops, reads } = await run(fn, {
      event: trigger("go"),
      incoming: [message("user", "again")],
      runId: "run-start-row",
    });

    expect(output).toEqual(["agent/message", "agent/message"]);
    expect(reads).toContain("inbox:start");
    // The read is lazy: it is not one of the ops that cost a step.
    expect(
      ops.map((op) => {
        return op.id;
      }),
    ).not.toContain("inbox:start");
  });

  test("an improver-shaped definition: five sources with an if against the trigger are one inbox", async () => {
    const names = ["reply", "reaction", "mention", "tap", "dry"] as const;
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "improver",
        kv: createKv({ adapter: memoryKvAdapter() }),
        inbox: names.map((name) => {
          return {
            event: `chat/${name}`,
            if: "async.data.thread == event.data.thread",
          };
        }),
      },
      async ({ inbox }) => {
        await inbox.next();
        const heard: string[] = [];

        for (const _ of names) {
          const next = await inbox.next();

          heard.push(next?.name ?? "none");
        }

        return heard;
      },
    );

    const { output, ops } = await run(fn, {
      event: trigger("go"),
      incoming: names.map((name) => {
        return { name: `chat/${name}`, data: { thread: "t1" }, stream: 4 };
      }),
    });

    expect(output).toEqual(names.map((name) => `chat/${name}`));

    const sources = ops.flatMap((op) => {
      return (
        (op.opts as { sources?: { event: string; if?: string }[] })?.sources ??
        []
      );
    });

    // The if is handed to the executor as written: `event` is the trigger.
    expect(
      sources.filter((source) => {
        return source.event.startsWith("chat/");
      }),
    ).toEqual(
      names.map((name) => {
        return {
          event: `chat/${name}`,
          if: "(async.data.thread == event.data.thread)",
        };
      }),
    );
  });

  test("next({ timeout }) returns null when it expires, and a later message is read by the next call", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const first = await inbox.next();
        const expired = await inbox.next({ timeout: "1s" });
        const second = await inbox.next();

        return [textOf(first), expired, textOf(second)];
      },
    );

    const { output } = await run(fn, {
      event: trigger("a"),
      incoming: [message("user", "b")],
      timeouts: 1,
    });

    expect(output).toEqual(["a", null, "b"]);
  });

  test("a message that arrives before the timeout is returned", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        await inbox.next();
        const second = await inbox.next({ timeout: "30s" });

        return textOf(second);
      },
    );

    const { output } = await run(fn, {
      event: trigger("a"),
      saved: [message("user", "b")],
    });

    expect(output).toBe("b");
  });
});

describe("agent cleanup", () => {
  test("a deferred function clears the run's run-scoped KV", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const { cleanup } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async () => {},
    );
    const bound = kv.with({ id: testClientId, env: null });
    await bound.scope("run", "run1").set("scratch", 1);
    await bound.scope("run", "run2").set("scratch", 2);

    await run(cleanup, {
      event: {
        name: "inngest/deferred.schedule",
        data: {
          runId: "run1",
          _inngest: {
            fn_slug: `${testClientId}-bot-cleanup`,
            parent_fn_slug: `${testClientId}-bot`,
            parent_run_id: "run1",
          },
        },
      },
    });

    expect(await bound.scope("run", "run1").all()).toEqual({});
    expect(await bound.scope("run", "run2").all()).toEqual({ scratch: 2 });
  });

  test("the trigger is the inbox's first message and is read without a step or a wait", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const first = await inbox.next();

        return textOf(first);
      },
    );

    const { output, ops } = await run(fn, { event: trigger("go") });

    expect(output).toBe("go");
    expect(
      ops.map((op) => {
        return op.op;
      }),
    ).not.toContain("wait");
  });

  test("nextBatch() returns what is unread, skipping a message that breaks nothing, and a closed inbox returns undefined", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        await inbox.next();
        const batch = await inbox.nextBatch();
        await inbox.close();
        const closed = await inbox.next();

        return [
          batch?.map((m) => {
            return textOf(m);
          }),
          closed,
        ];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [message("user", "a"), message("steer", "b")],
    });

    expect(output).toEqual([["a", "b"], undefined]);
  });

  test("the agent opens one inbox for its own events, with a source per event", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async () => {},
    );

    const { ops } = await run(fn, { event: trigger("hi") });

    expect(ops[0]).toMatchObject({ id: "inbox", op: "open" });
    expect(
      (ops[0]?.opts as { sources: { event: string }[] }).sources.map(
        (source) => {
          return source.event;
        },
      ),
    ).toEqual(["agent/message", "agent/steer"]);
  });
});

describe("createAgents", () => {
  test("functions() lists each agent's function and cleanup, in order", () => {
    const client = makeClient();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const agents = createAgents(client);

    expect(agents.functions()).toEqual([]);

    agents.agent({ id: "a", kv }, async () => {});
    agents.agent({ id: "b", kv }, async () => {});

    expect(
      agents.functions().map((fn) => {
        return fn.id(client.id);
      }),
    ).toEqual([
      `${testClientId}-a`,
      `${testClientId}-a-cleanup`,
      `${testClientId}-a-finished`,
      `${testClientId}-b`,
      `${testClientId}-b-cleanup`,
      `${testClientId}-b-finished`,
      `${testClientId}-agents-announce`,
    ]);
  });

  test("agents of another factory are not listed", () => {
    const client = makeClient();
    const kv = createKv({ adapter: memoryKvAdapter() });

    createAgents(client).agent({ id: "a", kv }, async () => {});

    expect(createAgents(client).functions()).toEqual([]);
  });
});

describe("thread state", () => {
  const record = async (kv: ReturnType<typeof createKv>) => {
    const found = await kv
      .with({ id: testClientId, env: null })
      .scope("thread", "t1")
      .get("__state");

    // The status changes with their times are not part of what state() shows.
    const { transitions: _transitions, ...rest } = (found ?? {}) as {
      transitions?: unknown;
    };

    return found ? rest : found;
  };

  test("the run, each turn and the wait for the next message write what state() shows", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    // The body replays on every request, so a turn's record is kept by turn.
    const seen = new Map<number, unknown>();
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async ({ inbox, control }) => {
        let n = -1;

        for await (const m of inbox) {
          n += 1;

          await agent.loop({
            id: `turn${n}`,
            model: agent.model(async () => {
              return {
                ...say(`reply to ${textOf(m)}`),
                usage: { input: 10, output: 5 },
              };
            }),
            prompt: m,
            tools: {},
            ...control,
          });
          seen.set(n, await record(kv));

          if (n === 1) {
            break;
          }
        }
      },
    );

    await run(fn, { event: trigger("one"), saved: [message("user", "two")] });

    expect([...seen.values()]).toMatchObject([
      {
        status: "running",
        turn: 1,
        summary: "reply to one",
        usage: { input: 10, output: 5 },
        runId: "run",
        inflight: { text: "one" },
        restarts: 0,
      },
      {
        status: "running",
        turn: 1,
        summary: "reply to two",
        usage: { input: 20, output: 10 },
        runId: "run",
        inflight: { text: "two" },
        restarts: 0,
      },
    ]);
    expect(await record(kv)).toMatchObject({ status: "running" });
  });

  test("a message waited for after the first marks the thread waiting", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async ({ inbox }) => {
        await inbox.next();
        await inbox.next();
      },
    );

    // The second read finds nothing, so the run ends waiting.
    await run(fn, { event: trigger("one") });

    expect(await record(kv)).toMatchObject({ status: "waiting", runId: "run" });
  });

  test("a batch waited for after the first marks the thread waiting", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async ({ inbox }) => {
        for await (const _batch of inbox.batches()) {
          // Each batch is answered, then the next one is waited for.
        }
      },
    );

    // The second read finds nothing, so the run ends waiting.
    await run(fn, { event: trigger("one") });

    expect(await record(kv)).toMatchObject({ status: "waiting", runId: "run" });
  });

  test("a delivered batch after the first marks the thread running with its message in flight", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const seen: unknown[] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async ({ inbox }) => {
        await inbox.next();
        await inbox.nextBatch();
        seen.push(await record(kv));
      },
    );

    await run(fn, {
      event: trigger("one"),
      saved: [message("user", "two")],
    });

    expect(seen.at(-1)).toMatchObject({
      status: "running",
      inflight: { text: "two" },
    });
  });

  test("a batch wait that expires marks the thread running again when a message was delivered", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const seen: unknown[] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async ({ inbox }) => {
        await inbox.nextBatch();
        await inbox.nextBatch({ timeout: "1s" }).catch(() => undefined);
        seen.push(
          ((await record(kv)) as { status?: string } | undefined)?.status,
        );
      },
    );

    await run(fn, { event: trigger("one"), timeouts: 1 });

    expect(seen.at(-1)).toBe("running");
  });

  test("a wait that expires marks the thread running again when a message was delivered", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const seen: unknown[] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async ({ inbox }) => {
        await inbox.next();
        await inbox.next({ timeout: "1s" }).catch(() => undefined);
        seen.push(
          ((await record(kv)) as { status?: string } | undefined)?.status,
        );
      },
    );

    await run(fn, { event: trigger("one"), timeouts: 1 });

    // The wait marked the thread waiting; its expiry means the agent goes on.
    expect(seen.at(-1)).toBe("running");
  });

  test("a finished run marks its own record idle and leaves a newer run's alone", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const { cleanup } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async () => {},
    );
    const thread = kv
      .with({ id: testClientId, env: null })
      .scope("thread", "t1");
    const base = { turn: 2, usage: { input: 1, output: 1 } };
    await thread.set("__state", { ...base, status: "running", runId: "r1" });

    await run(cleanup, {
      event: {
        name: "inngest/deferred.schedule",
        data: {
          runId: "r1",
          thread: "t1",
          _inngest: {
            fn_slug: `${testClientId}-bot-cleanup`,
            parent_fn_slug: `${testClientId}-bot`,
            parent_run_id: "r1",
          },
        },
      },
    });

    expect(await thread.get("__state")).toMatchObject({
      status: "idle",
      runId: "r1",
      turn: 2,
    });

    await thread.set("__state", { ...base, status: "running", runId: "r2" });
    await run(cleanup, {
      event: {
        name: "inngest/deferred.schedule",
        data: {
          runId: "r1",
          thread: "t1",
          _inngest: {
            fn_slug: `${testClientId}-bot-cleanup`,
            parent_fn_slug: `${testClientId}-bot`,
            parent_run_id: "r1",
          },
        },
      },
    });

    expect(await thread.get("__state")).toMatchObject({
      status: "running",
      runId: "r2",
    });
  });
});

describe("trigger", () => {
  const make = (on: unknown) => {
    return createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        on,
      } as never,
      async ({ trigger }) => {
        return trigger ?? "none";
      },
    );
  };

  test("an event of on starts the run with the event itself on the body context", async () => {
    const { fn } = make({ event: "shop/order", thread: "event.data.id" });

    const { output } = await run(fn, {
      event: { name: "shop/order", data: { id: "o1", total: 5 } },
    });

    expect(output).toMatchObject({
      name: "shop/order",
      data: { id: "o1", total: 5 },
    });
  });

  test("a cron tick is the trigger of a cron run", async () => {
    const { fn } = make({ cron: "0 * * * *" });

    const { output } = await run(fn, {
      event: { name: "inngest/scheduled.timer", data: { cron: "0 * * * *" } },
    });

    expect(output).toMatchObject({
      name: "inngest/scheduled.timer",
      data: { cron: "0 * * * *" },
    });
  });

  test("an invoke trigger shows the caller's input without what the SDK told the agent", async () => {
    const { fn } = make(invoke(z.object({ question: z.string() })));

    const { output } = await run(fn, {
      event: {
        name: "inngest/function.invoked",
        data: { question: "why", _agent: { thread: "t" } },
      },
    });

    expect(output).toEqual({
      name: "inngest/function.invoked",
      data: { question: "why" },
    });
  });

  test("depth is how many agents deep an invoked run is; the trigger shows the caller's input only", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        on: invoke(z.object({ question: z.string() })),
      } as never,
      async ({ depth, trigger }) => {
        return { depth, trigger };
      },
    );

    const invoked = await run(fn, {
      event: {
        name: "inngest/function.invoked",
        data: { question: "why", _agent: { depth: 2, thread: "t" } },
      },
    });

    expect(invoked.output).toEqual({
      depth: 2,
      trigger: { name: "inngest/function.invoked", data: { question: "why" } },
    });
  });

  test("depth is 0 for an event, a cron tick and a thread message", async () => {
    const depthOf = async (
      on: unknown,
      event: { name: string; data: Record<string, unknown> },
    ) => {
      const { fn } = createAgentFunction(
        makeClient(),
        {
          id: "bot",
          kv: createKv({ adapter: memoryKvAdapter() }),
          on,
        } as never,
        async ({ depth }) => {
          return depth;
        },
      );

      return (await run(fn, { event })).output;
    };
    const keyed = { event: "shop/order", thread: "event.data.id" };

    expect(
      await depthOf(keyed, { name: "shop/order", data: { id: "o1" } }),
    ).toBe(0);
    expect(
      await depthOf(
        { cron: "0 * * * *" },
        { name: "inngest/scheduled.timer", data: { cron: "0 * * * *" } },
      ),
    ).toBe(0);
    expect(await depthOf(keyed, message("user", "hi"))).toBe(0);
  });

  test("a plain thread message has no trigger event", async () => {
    const { fn } = make({ event: "shop/order", thread: "event.data.id" });

    const { output } = await run(fn, { event: message("user", "hi") });

    expect(output).toBe("none");
  });
});

describe("agent limits", () => {
  test("a dollar budget without a price throws when the agent is defined", () => {
    const define = (limits: AgentFunctionConfig["limits"]) => {
      return () => {
        return createAgentFunction(
          makeClient(),
          { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }), limits },
          async () => {},
        );
      };
    };

    expect(define({ budget: { usd: 1 } })).toThrow(
      /limits\.budget\.usd without limits\.price/,
    );
    expect(
      define({ budget: { usd: 1 }, price: { "*": { input: 1, output: 1 } } }),
    ).not.toThrow();
    expect(define({ budget: { tokens: 10 } })).not.toThrow();
  });

  const spend = (input: number, output: number): AgentModelResponse => {
    return {
      message: { role: "assistant", content: [] },
      toolCalls: [{ id: "c1", name: "missing", input: {} }],
      usage: { input, output },
    };
  };

  test("the loop stops before the next model call once the budget is spent", async () => {
    let calls = 0;
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        limits: { budget: { tokens: 20 } },
      },
      async ({ inbox, control }) => {
        const first = await inbox.next();
        const result = await agent.loop({
          model: agent.model(async () => {
            calls += 1;

            return spend(8, 4);
          }),
          prompt: first ?? "",
          tools: {},
          ...control,
        });

        return [result.stopped, result.turns, result.reason];
      },
    );

    const { output } = await run(fn, { event: trigger("go") });

    expect(calls).toBe(2);
    expect(output).toEqual([
      "budget",
      2,
      "Budget spent: 24 of 20 tokens used.",
    ]);
  });

  test("a dollar budget inherited by an agent with no price fails the run instead of counting calls as free", async () => {
    const start = async (limits?: AgentFunctionConfig["limits"]) => {
      let ran = false;
      const { fn } = createAgentFunction(
        makeClient(),
        { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }), limits },
        async () => {
          ran = true;
        },
      );
      const event = trigger("go");

      await run(fn, {
        event: {
          ...event,
          data: {
            ...event.data,
            _agent: { depth: 1, limits: { budget: { usd: 1 } } },
          },
        },
      });

      return ran;
    };

    expect(await start({ price: { "*": { input: 1, output: 1 } } })).toBe(true);
    expect(await start()).toBe(false);
  });

  test("a dollar budget handed down is not kept: a later plain message runs an unpriced agent", async () => {
    let ran = 0;
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async () => {
        ran += 1;
      },
    );
    const invoked = trigger("go");

    await run(fn, {
      event: {
        ...invoked,
        data: {
          ...invoked.data,
          _agent: { depth: 1, limits: { budget: { usd: 1, tokens: 500 } } },
        },
      },
    });

    expect(ran).toBe(0);

    await run(fn, { event: trigger("again") });

    expect(ran).toBeGreaterThan(0);
  });

  test("a malformed dollar budget handed down stops the loop as a spent budget, not as a missing price", async () => {
    let models = 0;
    const seen: unknown[] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox, control }) => {
        const first = await inbox.next();
        const result = await agent.loop({
          model: agent.model(async () => {
            models += 1;

            return spend(1, 1);
          }),
          prompt: first ?? "",
          tools: {},
          ...control,
        });

        seen.push(result.stopped);
      },
    );
    const invoked = trigger("go");

    await run(fn, {
      event: {
        ...invoked,
        data: {
          ...invoked.data,
          _agent: { depth: 1, limits: { budget: { usd: "lots" } } },
        },
      },
    });

    expect(models).toBe(0);
    expect([...new Set(seen)]).toEqual(["budget"]);
  });

  test("an agent refuses to start a sub-agent past its inherited depth", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async () => {
        try {
          await invokeAgent("team/leaf", {}, {});
        } catch (error) {
          return (error as Error).message;
        }

        return "started";
      },
    );
    const event = trigger("go");
    const { output } = await run(fn, {
      event: {
        ...event,
        data: { ...event.data, _agent: { depth: 1, limits: { depth: 0 } } },
      },
    });

    expect(output).toContain("team/leaf was not started");
  });
});

describe("inherited limits persist on the thread", () => {
  test("a later run started by a plain message keeps the limits the sub-agent inherited", async () => {
    const store = createKv({ adapter: memoryKvAdapter() });
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: store },
      async () => {
        try {
          await invokeAgent("team/leaf", {}, {});
        } catch (error) {
          return (error as Error).message;
        }

        return "started";
      },
    );
    const first = trigger("go");
    await run(fn, {
      event: {
        ...first,
        data: { ...first.data, _agent: { depth: 1, limits: { depth: 0 } } },
      },
    });

    const { output } = await run(fn, { event: trigger("again") });

    expect(output).toContain("team/leaf was not started");
  });
});

describe("eager sandboxes", () => {
  const work = sandbox({ id: "work", tools: sandbox.tools.code() });
  const make = (use: boolean) => {
    const warnings: string[] = [];
    const brokenSandboxes = class extends Middleware.BaseMiddleware {
      readonly id = "test:broken-sandboxes";

      override transformFunctionInput(
        arg: Middleware.TransformFunctionInputArgs,
      ) {
        const sandbox = {
          create: async () => {
            throw new Error("no capacity");
          },
        };
        const logger = {
          ...(arg.ctx as { logger?: object }).logger,
          warn: (message: unknown) => {
            warnings.push(String(message));
          },
        };

        return {
          ...arg,
          ctx: {
            ...arg.ctx,
            logger,
            step: { ...arg.ctx.step, sandbox },
          },
        };
      }
    };
    const { fn } = createAgentFunction(
      new Inngest({ id: testClientId, middleware: [brokenSandboxes] }),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        sandboxes: { work: { sandbox: work, start: "eager" } },
      },
      async ({ inbox, sandboxes }) => {
        await inbox.next();

        if (!use) {
          return "done";
        }

        try {
          await sandboxes.work?.get();
        } catch (error) {
          return (error as Error).message;
        }

        return "done";
      },
    );

    return { fn, warnings };
  };

  test("an unused eager sandbox that failed to create only warns", async () => {
    const { fn, warnings } = make(false);
    const { output } = await run(fn, { event: trigger("go") });

    expect(output).toBe("done");
    expect(warnings.join("\n")).toContain("no capacity");
  });

  test("a used eager sandbox that failed to create raises to its user, with no warning", async () => {
    const { fn, warnings } = make(true);
    const { output } = await run(fn, { event: trigger("go") });

    expect(output).toBe("no capacity");
    expect(warnings).toEqual([]);
  });
});
