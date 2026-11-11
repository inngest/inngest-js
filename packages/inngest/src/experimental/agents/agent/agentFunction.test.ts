/**
 * @module
 * Tests for the agent function body against a fake executor.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { Middleware } from "../../../components/middleware/middleware.ts";
import {
  eventType,
  invoke,
  staticSchema,
} from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import { agentMessage } from "../inbox/events.ts";
import type { Kv } from "../kv/kv.ts";
import type { AgentModelResponse, ModelMessage } from "../loop/loop.ts";
import { model } from "../loop/loopKit.ts";
import { sandbox } from "../sandboxes/defs.ts";
import {
  applyThreadWrite,
  emptySnapshot,
  type ThreadWriteOp,
} from "../threads/threadProtocol.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import { mintGrant, proofOf } from "./grant.ts";
import { freshKv, run, textOf } from "./test-helpers.ts";
import type { AgentFunctionConfig } from "./types.ts";

beforeEach(() => {
  freshKv();
});

/**
 * The sources a thread's holder subscribes with. Every source a definition
 * names belongs to the thread, not to the agent run: the agent subscribes to
 * forwards and nothing else.
 */
const threadSources = async (
  holder: InngestFunction.Any,
  thread = "t1",
): Promise<{ event: string; if?: string }[]> => {
  const held = await run(holder, {
    forward: false,
    event: {
      name: "inngest/function.invoked",
      data: { agent: `${testClientId}/bot`, thread, generation: 1 },
    },
  });

  return held.ops.flatMap((op) => {
    return (
      (op.opts as { sources?: { event: string; if?: string }[] })?.sources ?? []
    );
  });
};

const say = (text: string): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
  };
};

const message = (
  kind: "user",
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
    default:
      return {
        name: "agent/message",
        ...carried,
        data: { ...routing, content, ...data },
      };
  }
};

const trigger = (content: string) => {
  return message("user", content);
};

const makeClient = () => {
  return new Inngest({ id: testClientId });
};

// A start as another agent's `start()` sends it: one grant made for the
// thread, with the restriction lines the starter passed down.
const granted = (content: string, restrict: string[] = []) => {
  const client = makeClient();
  const thread = "t1";
  const id = "granted-1";
  const grant = mintGrant(client, {
    thread,
    restrict,
    lines: [`iss=${testClientId}`],
  });

  return message("user", content, thread, {
    id,
    from: { depth: 1, thread },
    "::agents": proofOf(client, grant, id, thread),
  });
};

const leaf = createAgentFunction(makeClient(), { id: "leaf" });

const userTexts = (messages: { role: string; content?: unknown }[]) => {
  return messages.flatMap((m) => {
    return m.role === "user" ? [m.content] : [];
  });
};

const reportAwareThread =
  'event.name == "agent/report" ? event.data["::agents"].thread : event.data.thread';

describe("agent function", () => {
  test("is addressed as appId/functionId and starts on its own non-stop messages", () => {
    const { fn, ref } = createAgentFunction(
      makeClient(),
      { id: "bot" },
      async () => {},
    );

    expect(ref).toBe(`${testClientId}/bot`);
    const config = fn["opts"] as {
      singleton: unknown;
      triggers: { event: string; if: string }[];
    };
    expect(config.singleton).toEqual({
      key: reportAwareThread,
      mode: "skip",
    });
    expect(config.triggers.map((t) => t.event)).toEqual([
      "agent/message",
      "agent/question",
      "agent/answer",
      "agent/finished",
      "agent/report",
      "agent/thread.forward",
    ]);
    expect(config.triggers[0]?.if).toContain(`"${testClientId}/bot"`);
  });

  test("the trigger is message 0, later messages are turns, and the conversation carries across turns", async () => {
    const prompts: unknown[][] = [];
    let turn = -1;
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        model: model(async (request) => {
          prompts.push(userTexts(request.messages));
          turn += 1;

          return say(`ok ${turn}`);
        }),
      },
      async ({ inbox, loop }) => {
        const first = await inbox.next();
        const one = await loop(first ? [first] : "");
        const two = await loop.with({ history: one.history })("two");
        const three = await loop.with({ history: two.history })("three");

        return three.text;
      },
    );

    const { output } = await run(fn, { event: trigger("one") });

    expect(output).toBe("ok 2");
    expect(prompts.slice(0, 3)).toEqual([
      ["one"],
      ["one", "two"],
      ["one", "two", "three"],
    ]);
  });

  test.each(["during", "after"] as const)(
    "a message that arrives %s a one-turn loop is taken by the handler's next drain",
    async (when) => {
      const { fn } = createAgentFunction(
        makeClient(),
        {
          id: "bot",
          model: model(async () => {
            return say("done");
          }),
        },
        async ({ inbox, loop }) => {
          const first = await inbox.drain();

          await loop(first);

          const second = await inbox.drain();

          return { first: first.map(textOf), second: second.map(textOf) };
        },
      );

      const { output } = await run(fn, {
        forward: true,
        event: trigger("go"),
        arrive: [{ event: message("user", "late"), at: "agent:model:1", when }],
      });

      expect(output).toEqual({ first: ["go"], second: ["late"] });
    },
  );

  test("a message that arrives while the thread starts is read by the first drain", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
      async ({ inbox }) => {
        return (await inbox.drain()).map(textOf);
      },
    );

    const { output, ops } = await run(fn, {
      event: trigger("go"),
      // While the thread starts: the run is asking its thread for state.
      arrive: [{ event: message("user", "early"), at: "thread:read" }],
    });

    expect(output).toEqual(["go", "early"]);

    // The inbox opens first, once, and every replay finds it in the same
    // place: no second open.
    expect(ops[0]).toMatchObject({ id: "inbox", op: "open" });
    expect(
      ops.filter((op) => {
        return op.op === "open";
      }),
    ).toHaveLength(1);
  });

  test("an inbox message is the event as it came", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
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
      saved: [message("user", "left")],
    });

    expect(output).toEqual([
      {
        name: "agent/message",
        text: "go",
        extra: [],
        isMessage: true,
      },
      {
        name: "agent/message",
        text: "left",
        extra: [],
        isMessage: true,
      },
    ]);
  });

  test("an invoke of a plain agent with { agent, thread, content } is message 1, an agent/message", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
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
          content: "go",
          from: { depth: 1 },
        },
      },
    });

    expect(output).toEqual([
      "agent/message",
      {
        agent: `${testClientId}/bot`,
        thread: "t1",
        content: "go",
        from: { depth: 1 },
      },
    ]);
  });
});

describe("inbox arrival", () => {
  const loopOnce = (seen: unknown[][]) => {
    return model(async (request) => {
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

  test("the handler's loop folds what is in the inbox into its model calls, and next() does not return it again", async () => {
    const seen: unknown[][] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        model: loopOnce(seen),
      },
      async ({ inbox, loop }) => {
        const first = await inbox.next();
        const result = await loop(first ? [first] : "");
        const next = await inbox.next({ timeout: "1s" });

        return [result.end, result.turns, next ? textOf(next) : "nothing left"];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [message("user", "also this")],
      timeouts: 1,
    });

    expect(seen[0]).toEqual(["go", "also this"]);
    expect(output).toEqual(["done", 2, "nothing left"]);
  });

  test("inbox.drain() takes the pending messages, and next() does not return them again", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
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
      saved: [message("user", "a"), message("user", "b")],
      timeouts: 1,
    });

    expect(output).toEqual([["agent/message", "agent/message"], null]);
  });
});

describe("inbox sources", () => {
  const ci = (state: string) => {
    return { name: "ci/status", data: { t: "t1", state }, stream: 4 };
  };

  test("a configured source maps to the thread and its events are user messages for the model", async () => {
    const filters: unknown[] = [];
    const { fn, threadHolder } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
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
    });

    // The filters belong to the thread, which is what subscribes to a
    // definition's sources; the agent run subscribes to forwards.
    for (const source of await threadSources(threadHolder)) {
      if (source.event === "ci/status" || source.event === "deploy/done") {
        filters.push([source.event, source.if]);
      }
    }

    expect(output).toEqual([
      "ci/status",
      { t: "t1", state: "red" },
      "deploy/done",
      { t: "t1", v: "1.2" },
    ]);
    // The filter is over `async` and ties the source to the run's thread.
    expect(filters).toContainEqual([
      "ci/status",
      '(has(async.data) && has(async.data.t)) && (async.data.state != "ok") && (async.data.t) == "t1"',
    ]);
    expect(filters).toContainEqual([
      "deploy/done",
      '(has(async.data) && has(async.data.t)) && (async.data.t) == "t1"',
    ]);
    // An event with nothing at the thread path is caught by a source of its
    // own, so the run can drop it with a warning.
    expect(filters).toContainEqual([
      "ci/status",
      '!(has(async.data) && has(async.data.t)) && (async.data.state != "ok")',
    ]);
  });

  test("a source's events are checked against its event type, and ones that break it are dropped", async () => {
    const status = eventType("ci/typed", {
      schema: z.object({ state: z.string() }),
    });
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
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

  test("the agent subscribes to forwards and nothing else; its thread subscribes to the sources", async () => {
    const { fn, threadHolder } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
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

    // The event reaches the run because its thread forwarded it, which is the
    // only way anything reaches an agent run.
    expect(output).toBe("ci/status");

    const sourcesOf = (opened: { opts: unknown }[]) => {
      return (
        opened[0]?.opts as { sources: { event: string }[] } | undefined
      )?.sources.map((source) => {
        return source.event;
      });
    };
    const opens = ops.filter((op) => {
      return (op.opts as { sources?: unknown } | undefined)?.sources;
    });

    // One subscription, one source. A second one in an agent run is the bug
    // that loses messages with an arbitrary survivor and no error.
    expect(opens).toHaveLength(1);
    expect(sourcesOf(opens)).toEqual(["agent/thread.forward"]);

    // The thread holds the rest: the agent layer's own events and every
    // configured source, with the extra filter for a source whose thread path
    // is missing.
    const held = await run(threadHolder, {
      forward: false,
      event: {
        name: "inngest/function.invoked",
        data: {
          agent: `${testClientId}/bot`,
          thread: "t1",
          generation: 1,
        },
      },
    });

    expect(
      sourcesOf(
        held.ops.filter((op) => {
          return (op.opts as { sources?: unknown } | undefined)?.sources;
        }),
      ),
    ).toEqual([
      "agent/message",
      "agent/question",
      "agent/answer",
      "agent/finished",
      "agent/report",
      "ci/status",
      "ci/status",
      "agent/thread.read",
      "agent/thread.write",
      "agent/thread.listen",
      "agent/thread.done",
    ]);
  });

  test("an agent with no listen and discovery: true gives the model the agent tools and neither inbox_listen nor inbox_close", async () => {
    const asked: string[][] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        discovery: true,
        model: model(async (request) => {
          asked.push((request.tools ?? []).map((tool) => tool.name));

          return say("done");
        }),
      },
      async ({ inbox, loop }) => {
        await inbox.next();
        await loop("go");

        return "ok";
      },
    );

    await run(fn, { event: trigger("go") });

    expect(asked).toEqual([
      [
        "list_agents",
        "describe_agent",
        "start_agent",
        "message_agent",
        "ask_agent",
        "stop_agent",
        "wait",
        "listen",
        "unlisten",
      ],
    ]);
  });

  test("an agent with no listen with discovery false gives the model none of the agent tools", async () => {
    const asked: string[][] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        discovery: false,
        model: model(async (request) => {
          asked.push((request.tools ?? []).map((tool) => tool.name));

          return say("done");
        }),
      },
      async ({ inbox, loop }) => {
        await inbox.next();
        await loop("go");

        return "ok";
      },
    );

    await run(fn, { event: trigger("go") });

    expect(asked).toEqual([["wait", "listen", "unlisten"]]);
  });

  test("the first read returns the trigger from state, and still draws its row at no step cost", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
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
    const { fn, threadHolder } = createAgentFunction(
      makeClient(),
      {
        id: "improver",
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

    const { output } = await run(fn, {
      event: trigger("go"),
      incoming: names.map((name) => {
        return { name: `chat/${name}`, data: { thread: "t1" }, stream: 4 };
      }),
    });

    expect(output).toEqual(names.map((name) => `chat/${name}`));

    // One inbox, and it is the thread's: five sources in one subscription.
    const sources = await threadSources(threadHolder);

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
      { id: "bot" },
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
      { id: "bot" },
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
    const kv = freshKv();
    const { cleanup } = createAgentFunction(
      makeClient(),
      { id: "bot" },
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
      { id: "bot" },
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
      { id: "bot" },
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
      saved: [message("user", "a"), message("user", "b")],
    });

    expect(output).toEqual([["a", "b"], undefined]);
  });

  test("the agent opens one inbox, whose one source is its thread's forwards", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
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
    ).toEqual(["agent/thread.forward"]);
  });
});

describe("createAgents", () => {
  test("functions() lists each agent's function and cleanup, in order", () => {
    const client = makeClient();
    freshKv();
    const agents = createAgents(client);

    expect(agents.functions()).toEqual([]);

    agents.agent({ id: "a" }, async () => {});
    agents.agent({ id: "b" }, async () => {});

    expect(
      agents.functions().map((fn) => {
        return fn.id(client.id);
      }),
    ).toEqual([
      `${testClientId}-a`,
      `${testClientId}-a-thread`,
      `${testClientId}-a-thread-run`,
      `${testClientId}-a-cleanup`,
      `${testClientId}-a-finished`,
      `${testClientId}-b`,
      `${testClientId}-b-thread`,
      `${testClientId}-b-thread-run`,
      `${testClientId}-b-cleanup`,
      `${testClientId}-b-finished`,
      `${testClientId}-agents-announce`,
      `${testClientId}-agents-finished`,
      `${testClientId}-agents-ask-timeout`,
      `${testClientId}-agents-parent-ended`,
    ]);
  });

  test("agents of another factory are not listed", () => {
    const client = makeClient();
    freshKv();

    createAgents(client).agent({ id: "a" }, async () => {});

    expect(createAgents(client).functions()).toEqual([]);
  });
});

describe("thread state", () => {
  /**
   * The record as the run holds it, read the way the run's own code would:
   * `kv.thread` inside a run reads what it already has.
   */
  const record = async (kv: Kv) => {
    const found = await kv
      .with({ id: testClientId, env: null })
      .scope("thread", "t1")
      .get(`__state:${testClientId}/bot`);

    // The status changes with their times are not part of the record's shape
    // that these tests are about.
    const { transitions: _transitions, ...rest } = (found ?? {}) as {
      transitions?: unknown;
    };

    return found ? rest : found;
  };

  /**
   * The record as the THREAD ends up holding it, from the writes the run sent
   * it. Thread state lives in the thread's holder, so this is what a later run
   * would be handed: there is nothing to read from a store afterwards.
   */
  const recorded = (sent: { name: string; data?: unknown }[]) => {
    const state = emptySnapshot();

    for (const event of sent) {
      if (event.name !== "agent/thread.write") {
        continue;
      }

      for (const op of (event.data as { ops?: ThreadWriteOp[] }).ops ?? []) {
        applyThreadWrite(state, op);
      }
    }

    const held = state.keys[`__state:${testClientId}/bot`];
    const { transitions: _transitions, ...rest } = (
      held ? JSON.parse(held.v) : {}
    ) as { transitions?: unknown };

    return held ? rest : undefined;
  };

  test("the run, each turn and the wait for the next message write what state() shows", async () => {
    const kv = freshKv();
    // The body replays on every request, so a turn's record is kept by turn.
    const seen = new Map<number, unknown>();
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        model: model(async (request) => {
          return {
            ...say(
              `reply to ${(request.messages.at(-1) as { content: string }).content}`,
            ),
            usage: { input: 10, output: 5 },
          };
        }),
      },
      async ({ inbox, loop }) => {
        const first = await inbox.next();

        await loop(first ? [first] : "");
        seen.set(0, await record(kv));
      },
    );

    const { sent } = await run(fn, { event: trigger("one") });

    expect([...seen.values()]).toMatchObject([
      {
        status: "running",
        turn: 1,
        summary: "reply to one",
        usage: { input: 10, output: 5 },
        runId: "run",
        inflight: { content: "one" },
        restarts: 0,
      },
    ]);
    // And the thread was told the same thing, which is what a later run is
    // handed.
    expect(recorded(sent)).toMatchObject({ status: "running", turn: 1 });
  });

  test("a message waited for after the first marks the thread waiting", async () => {
    const kv = freshKv();
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
      async ({ inbox }) => {
        await inbox.next();
        await inbox.next();
      },
    );

    // The second read finds nothing, so the run ends waiting.
    const { sent } = await run(fn, { event: trigger("one") });

    expect(recorded(sent)).toMatchObject({ status: "waiting", runId: "run" });
  });

  test("a batch waited for after the first marks the thread waiting", async () => {
    freshKv();
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
      async ({ inbox }) => {
        for await (const _batch of inbox.batches()) {
          // Each batch is answered, then the next one is waited for.
        }
      },
    );

    // The second read finds nothing, so the run ends waiting.
    const { sent } = await run(fn, { event: trigger("one") });

    expect(recorded(sent)).toMatchObject({ status: "waiting", runId: "run" });
  });

  test("a delivered batch after the first marks the thread running with its message in flight", async () => {
    const kv = freshKv();
    const seen: unknown[] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
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
      inflight: { content: "two" },
    });
  });

  test("a batch wait that expires marks the thread running again when a message was delivered", async () => {
    const kv = freshKv();
    const seen: unknown[] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
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
    const kv = freshKv();
    const seen: unknown[] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
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
    freshKv();

    const { cleanup } = createAgentFunction(
      makeClient(),
      { id: "bot" },
      async () => {},
    );
    const base = { turn: 2, usage: { input: 1, output: 1 } };
    const holding = (over: Record<string, unknown>) => {
      return {
        ...emptySnapshot(),
        fresh: false,
        keys: {
          [`__state:${testClientId}/bot`]: {
            v: JSON.stringify({ ...base, ...over }),
          },
        },
      };
    };
    const deferred = {
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
    };

    // The thread hands the cleanup the record its run left, and the cleanup
    // tells the thread what to make of it: there is no store between them.
    const mine = await run(cleanup, {
      event: deferred,
      thread: holding({ status: "running", runId: "r1" }),
    });

    expect(recorded(mine.sent)).toMatchObject({
      status: "idle",
      runId: "r1",
      turn: 2,
    });

    // A newer run holds the record, so this one leaves it alone.
    const newer = await run(cleanup, {
      event: deferred,
      thread: holding({ status: "running", runId: "r2" }),
    });

    // Nothing was written, so the thread keeps what the newer run left.
    expect(recorded(newer.sent)).toBeUndefined();
  });
});

describe("event", () => {
  const make = (triggers: unknown) => {
    return createAgentFunction(
      makeClient(),
      {
        id: "bot",
        triggers,
      } as never,
      async ({ event }) => {
        return { name: event.name, data: event.data };
      },
    );
  };

  test("an event of triggers is the event on the body context, as sent", async () => {
    const { fn } = make({ event: "shop/order", thread: "event.data.id" });

    const { output } = await run(fn, {
      event: { name: "shop/order", data: { id: "o1", total: 5 } },
    });

    expect(output).toMatchObject({
      name: "shop/order",
      data: { id: "o1", total: 5 },
    });
  });

  test("a cron tick is the event of a cron run", async () => {
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
        data: { question: "why", from: { thread: "t" } },
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
        triggers: invoke(z.object({ question: z.string() })),
      } as never,
      async ({ depth, event }) => {
        return { depth, trigger: { name: event.name, data: event.data } };
      },
    );

    const invoked = await run(fn, {
      event: {
        name: "inngest/function.invoked",
        data: { question: "why", from: { depth: 2, thread: "t" } },
      },
    });

    expect(invoked.output).toEqual({
      depth: 2,
      trigger: { name: "inngest/function.invoked", data: { question: "why" } },
    });
  });

  test("depth is 0 for an event, a cron tick and a thread message", async () => {
    const depthOf = async (
      triggers: unknown,
      event: { name: string; data: Record<string, unknown> },
    ) => {
      const { fn } = createAgentFunction(
        makeClient(),
        {
          id: "bot",
          triggers,
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

  test("a plain thread message is the event of its run", async () => {
    const { fn } = make({ event: "shop/order", thread: "event.data.id" });

    const { output } = await run(fn, { event: message("user", "hi") });

    expect(output).toMatchObject({
      name: "agent/message",
      data: { content: "hi", thread: "t1" },
    });
  });
});

describe("agent limits", () => {
  test("an agent refuses to start a sub-agent past its inherited depth", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
      async () => {
        try {
          await leaf.start("x");
        } catch (error) {
          return (error as Error).message;
        }

        return "started";
      },
    );
    const { output } = await run(fn, { event: granted("go", ["depth=0"]) });

    expect(output).toContain("/leaf was not started");
  });
});

describe("inherited limits persist on the thread", () => {
  test("a later run started by a plain message keeps the limits the sub-agent inherited", async () => {
    freshKv();
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot" },
      async () => {
        try {
          await leaf.start("x");
        } catch (error) {
          return (error as Error).message;
        }

        return "started";
      },
    );
    // The first run keeps what it inherited on the thread, as a write; the
    // thread is what hands it to the next run, so the second run is given
    // what the first one wrote.
    const first = await run(fn, { event: granted("go", ["depth=0"]) });
    const held = emptySnapshot();

    for (const event of first.sent) {
      if (event.name !== "agent/thread.write") {
        continue;
      }

      for (const op of (event.data as { ops?: ThreadWriteOp[] }).ops ?? []) {
        applyThreadWrite(held, op);
      }
    }

    const { output } = await run(fn, {
      event: trigger("again"),
      thread: { ...held, fresh: false },
    });

    expect(output).toContain("/leaf was not started");
  });
});

describe("eager sandboxes", () => {
  const work = sandbox({ id: "work", tools: sandbox.tools.defaults });
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
        sandboxes: { work: { sandbox: work, start: "eager" } },
      },
      async ({ inbox, sandboxes }) => {
        await inbox.next();

        if (!use) {
          return "done";
        }

        try {
          await sandboxes.work?.commands.run("use", ["true"]);
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

describe("an inbox source with nothing at its thread path", () => {
  const sourced = (extra: Record<string, unknown> = {}) => {
    const warn = vi.fn();
    const client = new Inngest({
      id: testClientId,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    const { fn, threadHolder } = createAgentFunction(
      client,
      {
        id: "bot",
        inbox: [{ event: "ci/status", thread: "event.data.t" }],
        ...extra,
      } as never,
      async ({ inbox }) => {
        await inbox.next();
        const kept = await inbox.next();

        return kept ? { name: kept.name, data: kept.data } : null;
      },
    );

    return { fn, threadHolder, warn };
  };

  test("reaches no thread: the run drops it and the log warns", async () => {
    const { fn, warn } = sourced();

    const { output } = await run(fn, {
      event: trigger("go"),
      incoming: [
        { id: "lost", name: "ci/status", data: { state: "red" }, stream: 4 },
        {
          id: "found",
          name: "ci/status",
          data: { t: "t1", state: "red" },
          stream: 4,
        },
      ],
    });

    expect(output).toEqual({
      name: "ci/status",
      data: { t: "t1", state: "red" },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("nothing at its thread path"),
    );
  });

  test("the agent-wide thread expression fills in for a source with none", async () => {
    const { threadHolder } = sourced({
      inbox: [{ event: "ci/status", if: 'async.data.state == "red"' }],
      thread: "event.data.t",
    });
    // The thread subscribes to the sources, so the filter is its own.
    const filters = (await threadSources(threadHolder)).map((source) => {
      return `${source.event}: ${source.if}`;
    });

    expect(filters).toContain(
      'ci/status: (has(async.data) && has(async.data.t)) && (async.data.state == "red") && (async.data.t) == "t1"',
    );
  });
});

describe("the loop in an agent", () => {
  const recording = (answers: AgentModelResponse[]) => {
    const requests: { system?: string; messages: ModelMessage[] }[] = [];
    const scripted = model(async (request) => {
      requests.push(structuredClone(request));

      return answers[requests.length - 1] ?? say("more");
    });

    return { requests, scripted };
  };

  const callMissing: AgentModelResponse = {
    message: { role: "assistant", content: [] },
    toolCalls: [{ id: "c1", name: "missing", input: {} }],
  };

  test("an agent with a model and no handler answers: the final answer is the run's output", async () => {
    const { requests, scripted } = recording([callMissing, say("all done")]);
    const { fn } = createAgentFunction(makeClient(), {
      id: "bot",
      model: scripted,
      system: "Be brief.",
    });

    const { output } = await run(fn, { event: trigger("go") });

    expect(output).toBe("all done");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.system).toMatch(
      /^Be brief\.\n\n<inngest-runtime v="1">/,
    );
  });

  test("the definition's loop options apply to the loop the agent builds", async () => {
    const { requests, scripted } = recording([callMissing, callMissing]);
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", model: scripted, loop: { maxTurns: 2 } },
      async ({ inbox, loop }) => {
        const first = await inbox.next();
        const result = await loop(first ? [first] : "");

        return [result.end, result.turns];
      },
    );

    const { output } = await run(fn, { event: trigger("go") });

    expect(output).toEqual(["maxTurns", 2]);
    expect(requests).toHaveLength(2);
  });

  test("loop.with({ model }) keeps the agent's system prompt and tools, and changes only the model", async () => {
    const own = recording([say("own")]);
    const other = recording([say("other")]);
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        model: own.scripted,
        system: "Agent system.",
      },
      async ({ loop }) => {
        return (await loop.with({ model: other.scripted })("hi")).text;
      },
    );

    const { output } = await run(fn, { event: trigger("go") });

    expect(output).toBe("other");
    expect(own.requests).toHaveLength(0);
    expect(other.requests[0]?.system).toMatch(
      /^Agent system\.\n\n<inngest-runtime/,
    );
  });

  test("a second run of the same thread starts with the first run's history; another thread does not", async () => {
    const remembered = recording([say("one"), say("two")]);
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", model: remembered.scripted },
      async ({ inbox, loop }) => {
        const first = await inbox.next();

        return (await loop(first ? [first] : "")).text;
      },
    );

    // The thread holds the history: the first run writes it there, and the
    // second is handed it when it obtains the thread's state.
    const first = await run(fn, { event: trigger("first") });
    const held = emptySnapshot();

    for (const event of first.sent) {
      if (event.name !== "agent/thread.write") {
        continue;
      }

      for (const op of (event.data as { ops?: ThreadWriteOp[] }).ops ?? []) {
        applyThreadWrite(held, op);
      }
    }

    await run(fn, {
      event: trigger("second"),
      thread: { ...held, fresh: false },
    });

    expect(remembered.requests[0]?.messages).toHaveLength(1);
    expect(remembered.requests[1]?.messages.length).toBeGreaterThan(2);

    const other = recording([say("x")]);
    const { fn: otherFn } = createAgentFunction(
      makeClient(),
      { id: "bot2", model: other.scripted },
      async ({ inbox, loop }) => {
        const first = await inbox.next();

        return (await loop(first ? [first] : "")).text;
      },
    );

    await run(otherFn, { event: message("user", "go", "t9") });

    expect(other.requests[0]?.messages).toHaveLength(1);
  });
});
