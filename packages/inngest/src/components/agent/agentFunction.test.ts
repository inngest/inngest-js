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
import {
  type AgentFunctionConfig,
  createAgentFunction,
} from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import { defineChannel } from "./channels.ts";
import { sandbox } from "./defs.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { type AgentMessage, type AgentModelResponse, agent } from "./loop.ts";
import { skills } from "./skills.ts";
import { run } from "./test-helpers.ts";

const say = (text: string): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
  };
};

const message = (
  kind: "user" | "steer" | "stop" | "request",
  content?: string,
  thread = "t1",
  extra: Record<string, unknown> = {},
) => {
  return {
    name: "agent/message",
    data: { agent: `${testClientId}/bot`, thread, kind, content, ...extra },
  };
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
    expect(config.triggers[0]?.event).toBe("agent/message");
    expect(config.triggers[0]?.if).toContain(`"${testClientId}/bot"`);
    expect(config.triggers[0]?.if).toContain('kind != "stop"');
  });

  test("the trigger is message 0, later messages are turns, and the conversation carries across turns", async () => {
    const prompts: unknown[][] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox, control }) => {
        let history: AgentMessage[] = [];
        let last = "";

        for await (const m of inbox) {
          const result = await agent.loop({
            id: `turn${m.seq}`,
            model: agent.model(async (request) => {
              prompts.push(userTexts(request.messages));

              return say(`ok ${m.seq}`);
            }),
            prompt: m.content ?? "",
            tools: {},
            history,
            ...control,
          });
          history = result.history;
          last = result.text;

          if (m.seq === 2) {
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

  test("steer messages fold into the running turn and a stop ends the loop; a user message waits for its own turn", async () => {
    const seen: unknown[][] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox, control }) => {
        const first = await inbox.next();

        const result = await agent.loop({
          model: agent.model(async (request) => {
            seen.push(userTexts(request.messages));

            return {
              message: { role: "assistant", content: [] },
              toolCalls: [{ id: "c1", name: "missing", input: {} }],
            };
          }),
          prompt: first?.content ?? "",
          tools: {},
          ...control,
        });
        const next = await inbox.next();

        return [result.stopped, result.turns, next?.content];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [
        message("steer", "left"),
        message("stop"),
        message("user", "next"),
      ],
    });

    expect(seen).toEqual([["go"]]);
    expect(output).toEqual(["stopped", 1, "next"]);
  });

  test("an inbox message is the event flat, with the thread message fields beside it", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const first = await inbox.next();
        const second = await inbox.next();

        return [first, second].map((m) => {
          return {
            name: m?.name,
            seq: m?.seq,
            kind: m?.kind,
            content: m?.content,
            hasEvent: m ? "event" in m : null,
            isMessage: m?.is("agent/message"),
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
        seq: 0,
        kind: "user",
        content: "go",
        hasEvent: false,
        isMessage: true,
      },
      {
        name: "agent/message",
        seq: 1,
        kind: "steer",
        content: "left",
        hasEvent: false,
        isMessage: true,
      },
    ]);
  });

  test("the event's fields win over a thread message field of the same name", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        await inbox.next();
        const second = await inbox.next();

        return [
          second?.id,
          second?.name,
          second?.data,
          second?.ts,
          second?.seq,
        ];
      },
    );
    const colliding = message("steer", "left", "t1", {
      id: "from-thread",
      name: "from-thread",
      ts: -1,
      seq: -1,
    });

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [{ ...colliding, id: "evt-real", ts: 1234 }],
    });

    expect(output).toEqual([
      "evt-real",
      "agent/message",
      colliding.data,
      1234,
      1,
    ]);
  });

  test("a thread message made from a trigger event (sent again by recovery) is that event", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        await inbox.next();
        const again = await inbox.next();

        return [again?.name, again?.id, again?.data, again?.content];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [
        message("user", "retry", "t1", {
          event: { id: "evt9", name: "slack/message", data: { text: "hi" } },
        }),
      ],
    });

    expect(output).toEqual(["slack/message", "evt9", { text: "hi" }, "retry"]);
  });

  test("a stop message that arrives while waiting is skipped", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const first = await inbox.next();
        const second = await inbox.next();

        return [first?.content, second?.content];
      },
    );

    const { output } = await run(fn, {
      event: trigger("a"),
      saved: [message("stop"), message("user", "b")],
    });

    expect(output).toEqual(["a", "b"]);
  });
});

describe("inbox arrival", () => {
  const loopOnce = (seen: unknown[][]) => {
    return agent.model(async (request) => {
      seen.push(userTexts(request.messages));

      return {
        message: { role: "assistant", content: [] },
        toolCalls: [{ id: "c1", name: "missing", input: {} }],
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
          prompt: first?.content ?? "",
          tools: {},
        });
        const next = await inbox.next();

        return [result.stopped, result.turns, next?.content];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [
        message("steer", "left"),
        message("stop"),
        message("user", "next"),
      ],
    });

    expect(seen).toEqual([["go"]]);
    expect(output).toEqual(["stopped", 1, "next"]);
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
          prompt: first?.content ?? "",
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

  test("inbox.unread() takes the pending messages, stops included, and next() does not return them again", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        await inbox.next();
        const drained = await inbox.unread();
        const after = await inbox.next({ timeout: "1s" });

        return [
          drained.map((m) => {
            return m.kind;
          }),
          after,
        ];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [message("user", "a"), message("stop"), message("steer", "b")],
      timeouts: 1,
    });

    expect(output).toEqual([["user", "stop", "steer"], undefined]);
  });

  describe("onArrival", () => {
    const arrivalFn = (calls: string[]) => {
      const kv = createKv({ adapter: memoryKvAdapter() });
      const { arrival } = createAgentFunction(
        makeClient(),
        {
          id: "bot",
          kv,
          onArrival: async ({ message: arrived, thread }) => {
            calls.push(`${thread}:${arrived.content}`);
          },
        },
        async () => {},
      );

      return { kv, arrival: arrival as NonNullable<typeof arrival> };
    };

    // The message arrived at 200. What counts is what the thread was doing then.
    const arrive = { ...message("user", "hello"), id: "evt-2", ts: 200 };
    const seed = async (
      kv: ReturnType<typeof createKv>,
      status: string,
      transitions: { status: string; at: number }[],
    ) => {
      await kv
        .with({ id: testClientId, env: null })
        .scope("thread", "t1")
        .set("__state", {
          status,
          turn: 0,
          usage: { input: 0, output: 0 },
          transitions,
        });
    };

    test("is a function of its own, listed only when the config has the hook", () => {
      const { arrival } = arrivalFn([]);

      expect(arrival.id(testClientId)).toBe(`${testClientId}-bot-arrival`);
      expect(
        createAgentFunction(
          makeClient(),
          { id: "plain", kv: createKv({ adapter: memoryKvAdapter() }) },
          async () => {},
        ).arrival,
      ).toBeUndefined();
    });

    test("runs for a message that reaches a thread busy with a turn", async () => {
      const calls: string[] = [];
      const { kv, arrival } = arrivalFn(calls);

      await seed(kv, "running", [{ status: "running", at: 100 }]);
      await run(arrival, { event: arrive });

      expect(calls).toEqual(["t1:hello"]);
    });

    test("is judged by what the thread was doing when the message arrived, not when it is looked at", async () => {
      const calls: string[] = [];
      const { kv, arrival } = arrivalFn(calls);

      // The message started the run (it arrived before the run did).
      await seed(kv, "running", [{ status: "running", at: 300 }]);
      await run(arrival, { event: arrive });

      // It woke a waiting run, which is running again by now.
      await seed(kv, "running", [
        { status: "running", at: 100 },
        { status: "waiting", at: 150 },
        { status: "running", at: 300 },
      ]);
      await run(arrival, { event: arrive });

      // The run had ended when it arrived, though the record is read later.
      await seed(kv, "idle", [
        { status: "running", at: 100 },
        { status: "idle", at: 150 },
      ]);
      await run(arrival, { event: arrive });

      expect(calls).toEqual([]);

      // It arrived mid-turn, and the run has gone back to waiting since.
      await seed(kv, "waiting", [
        { status: "running", at: 100 },
        { status: "waiting", at: 300 },
      ]);
      await run(arrival, { event: arrive });

      expect(calls).toEqual(["t1:hello"]);
    });
  });
});

describe("inbox sources", () => {
  const ci = (state: string) => {
    return { name: "ci/status", data: { t: "t1", state }, stream: 1 };
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
            if: 'event.data.state != "ok"',
          },
          {
            event: "deploy/done",
            thread: "event.data.t",
            message: (e) => {
              return `deployed ${(e.data as { v: string }).v}`;
            },
          },
        ],
      },
      async ({ inbox }) => {
        await inbox.next();
        const red = await inbox.next();
        const deployed = await inbox.next();

        return [red?.content, red?.kind, red?.name, deployed?.content];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      incoming: [
        ci("red"),
        { name: "deploy/done", data: { t: "t1", v: "1.2" }, stream: 2 },
      ],
      onOp: (op) => {
        const opts = op.opts as { event?: string; if?: string } | undefined;

        if (opts?.event === "ci/status" || opts?.event === "deploy/done") {
          filters.push([opts.event, opts.if]);
        }
      },
    });

    expect(output).toEqual([
      JSON.stringify({ event: "ci/status", data: { t: "t1", state: "red" } }),
      "user",
      "ci/status",
      "deployed 1.2",
    ]);
    // The filter is over `async` and ties the source to the run's thread.
    expect(filters).toContainEqual([
      "ci/status",
      '(async.data.state != "ok") && (async.data.t) == "t1"',
    ]);
    expect(filters).toContainEqual(["deploy/done", '(async.data.t) == "t1"']);
  });

  test("each source words its own messages, even for the same event", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        inbox: [
          {
            event: "ci/status",
            thread: "event.data.t",
            message: () => "from the first",
          },
          {
            event: "ci/status",
            if: 'event.data.t == "t1"',
            message: () => "from the second",
          },
        ],
      },
      async ({ inbox }) => {
        await inbox.next();
        const a = await inbox.next();
        const b = await inbox.next();

        return [a?.content, b?.content];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      incoming: [
        { ...ci("red"), stream: 1 },
        { ...ci("red"), stream: 2 },
      ],
    });

    expect(output).toEqual(["from the first", "from the second"]);
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

        return JSON.parse(kept?.content ?? "null");
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      incoming: [
        {
          id: "typed-bad",
          name: "ci/typed",
          data: { t: "t1", state: 7 },
          stream: 1,
        },
        {
          id: "typed-ok",
          name: "ci/typed",
          data: { t: "t1", state: "green" },
          stream: 1,
        },
      ],
    });

    expect(output).toEqual({
      event: "ci/typed",
      data: { t: "t1", state: "green" },
    });
  });

  test("listen() adds a source mid-run, stop() removes it, and a source needs a thread or an if", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        await inbox.next();
        const listener = await inbox.listen("ci/status", {
          thread: "event.data.t",
        });
        const heard = await inbox.next();

        await listener.stop();

        const bare = await inbox.listen("ci/status", {} as never).then(
          () => "added",
          (error: Error) => error.message,
        );

        return [heard?.name, bare];
      },
    );

    const { output, ops } = await run(fn, {
      event: trigger("go"),
      incoming: [ci("red")],
    });

    expect(output).toEqual([
      "ci/status",
      "An inbox source needs a `thread` or an `if`.",
    ]);
    expect(
      ops.map((op) => {
        return [op.mode, op.stream ?? 0];
      }),
    ).toContainEqual(["stop", 1]);
  });

  test("current() lists every message saved so far, stops included but not the trigger, and moves no cursor", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const first = await inbox.next();
        const all = await inbox.current();
        const second = await inbox.next();

        return [
          first?.content,
          all.map((m) => {
            return m.kind;
          }),
          second?.content,
        ];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [message("user", "b"), message("stop"), message("user", "c")],
    });

    expect(output).toEqual(["go", ["user", "stop", "user"], "b"]);
  });
});

describe("inbox timeouts", () => {
  test("next({ timeout }) returns undefined when it expires, and a later message is read by the next call", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const first = await inbox.next();
        const expired = await inbox.next({ timeout: "1s" });
        const second = await inbox.next();

        return [first?.content, expired, second?.content];
      },
    );

    const { output } = await run(fn, {
      event: trigger("a"),
      incoming: [message("user", "b")],
      timeouts: 1,
    });

    expect(output).toEqual(["a", undefined, "b"]);
  });

  test("a stop message that is skipped starts a new wait, which can expire", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        await inbox.next();
        const expired = await inbox.next({ timeout: "1s" });

        return expired === undefined ? "expired" : "message";
      },
    );

    const { output } = await run(fn, {
      event: trigger("a"),
      saved: [message("stop")],
      timeouts: 1,
    });

    expect(output).toBe("expired");
  });

  test("a message that arrives before the timeout is returned", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        await inbox.next();
        const second = await inbox.next({ timeout: "30s" });

        return second?.content;
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

  test("the agent function defers the cleanup with its run ID", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async () => {},
    );

    const { ops } = await run(fn, { event: trigger("hi") });

    expect(ops[0]).toEqual({ id: "inbox:0:open", mode: "open" });
  });
});

describe("steering", () => {
  test("a stop sent after a next-turn message still applies to the running turn, and the next-turn message keeps its place", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox, control }) => {
        const first = await inbox.next();
        const result = await agent.loop({
          model: agent.model(async () => {
            return {
              message: { role: "assistant", content: [] },
              toolCalls: [{ id: "c1", name: "missing", input: {} }],
            };
          }),
          prompt: first?.content ?? "",
          tools: {},
          ...control,
        });
        const next = await inbox.next();

        return [result.stopped, next?.content];
      },
    );

    const { output } = await run(fn, {
      event: trigger("go"),
      saved: [message("user", "next"), message("stop")],
    });

    expect(output).toEqual(["stopped", "next"]);
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
    ]);
  });

  test("agents of another factory are not listed", () => {
    const client = makeClient();
    const kv = createKv({ adapter: memoryKvAdapter() });

    createAgents(client).agent({ id: "a", kv }, async () => {});

    expect(createAgents(client).functions()).toEqual([]);
  });

  test("every instance with an agent that bakes skills lists the client's one bake function", () => {
    const client = makeClient();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const baking = {
      id: "b",
      kv,
      sandboxes: {
        work: sandbox({
          id: "w",
          skills: [skills.git("a/b")],
        }),
      },
    };
    const first = createAgents(client);
    const second = createAgents(client);

    first.agent(baking, async () => {});
    second.agent({ ...baking, id: "c" }, async () => {});
    createAgents(client).agent({ id: "plain", kv }, async () => {});

    const bakeOf = (agents: ReturnType<typeof createAgents>) => {
      return agents.functions().filter((fn) => {
        return fn.id(client.id).endsWith("agent-skills-bake");
      });
    };

    expect(bakeOf(first)).toHaveLength(1);
    expect(bakeOf(second)).toEqual(bakeOf(first));
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
    // The body replays on every request, so a turn's record is kept by seq.
    const seen = new Map<number, unknown>();
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async ({ inbox, control }) => {
        for await (const m of inbox) {
          await agent.loop({
            id: `turn${m.seq}`,
            model: agent.model(async () => {
              return {
                ...say(`reply to ${m.content}`),
                usage: { input: 10, output: 5 },
              };
            }),
            prompt: m.content ?? "",
            tools: {},
            ...control,
          });
          seen.set(m.seq, await record(kv));

          if (m.seq === 1) {
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
        inflight: { content: "one" },
        restarts: 0,
      },
      {
        status: "running",
        turn: 1,
        summary: "reply to two",
        usage: { input: 20, output: 10 },
        runId: "run",
        inflight: { content: "two" },
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

  test("a wait that expires after only a skipped stop leaves a running thread running", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const seen: unknown[] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async ({ inbox }) => {
        const before = ((await record(kv)) as { status?: string } | undefined)
          ?.status;
        // The trigger is a stop, which the inbox skips.
        const expired = await inbox.next({ timeout: "1s" });

        seen.push(
          expired,
          before,
          ((await record(kv)) as { status?: string } | undefined)?.status,
        );
      },
    );

    await run(fn, { event: message("stop"), timeouts: 1 });

    // The body ran again for each request; the last run is the final one.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.slice(-3)).toEqual([undefined, "running", "running"]);
  });

  test("a wait that expires does not undo a stop", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const seen: unknown[] = [];
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async ({ inbox }) => {
        await inbox.next();
        await kv
          .with({ id: testClientId, env: null })
          .scope("thread", "t1")
          .set("__state", { status: "stopped", turn: 0, runId: "run" });
        await inbox.next({ timeout: "1s" });
        seen.push(
          ((await record(kv)) as { status?: string } | undefined)?.status,
        );
      },
    );

    await run(fn, { event: trigger("one"), timeouts: 1 });

    expect(seen.at(-1)).toBe("stopped");
  });

  test("honoring a stop request marks the thread stopped", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async ({ inbox, control }) => {
        await inbox.next();
        await agent.loop({
          model: agent.model(async () => {
            return {
              message: { role: "assistant", content: [] },
              toolCalls: [{ id: "c1", name: "missing", input: {} }],
            };
          }),
          prompt: "go",
          tools: {},
          ...control,
        });
      },
    );

    await run(fn, { event: trigger("go"), saved: [message("stop")] });

    expect(await record(kv)).toMatchObject({ status: "stopped" });
  });

  test("a stop request is scored on the step that records it, unless scores are off", async () => {
    const scored: string[] = [];

    for (const scores of [true, false]) {
      const kv = createKv({ adapter: memoryKvAdapter() });
      const { fn } = createAgentFunction(
        makeClient(),
        { id: "bot", kv, scores },
        async ({ inbox, control }) => {
          await inbox.next();
          await agent.loop({
            model: agent.model(async () => {
              return {
                message: { role: "assistant", content: [] },
                toolCalls: [{ id: "c1", name: "missing", input: {} }],
              };
            }),
            prompt: "go",
            tools: {},
            ...control,
          });
        },
      );

      await run(fn, {
        event: trigger("go"),
        saved: [message("stop")],
        onStep: (op) => {
          for (const update of op.metadata ?? []) {
            if (update.kind.startsWith("inngest.score.agent.stopped")) {
              scored.push(`${scores}:${op.userland?.id}`);
            }
          }
        },
      });
    }

    expect(scored.length).toBeGreaterThan(0);
    expect(scored.every((entry) => entry.startsWith("true:kv.update"))).toBe(
      true,
    );
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

  test("a plain thread message has no trigger event", async () => {
    const { fn } = make({ event: "shop/order", thread: "event.data.id" });

    const { output } = await run(fn, { event: message("user", "hi") });

    expect(output).toBe("none");
  });
});

describe("request and reply", () => {
  test("a request message replies to the thread that asked, through its signal", async () => {
    const client = makeClient();
    const signals: unknown[] = [];
    client.sendSignal = (async (signal: unknown) => {
      signals.push(signal);

      return { runId: "r" };
    }) as typeof client.sendSignal;
    const { fn } = createAgentFunction(
      client,
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        for await (const m of inbox) {
          if (m.kind === "request") {
            await m.reply({ answer: (m.payload as { n: number }).n * 2 });

            break;
          }
        }
      },
    );

    await run(fn, {
      event: message("request", undefined, "t1", {
        payload: { n: 21 },
        replyTo: "sig-1",
        from: "asker",
      }),
    });

    expect(signals).toEqual([{ signal: "sig-1", data: { answer: 42 } }]);
  });

  describe("with requests schemas", () => {
    const requests = {
      request: z.object({ n: z.number() }),
      reply: z.object({ answer: z.number() }),
    };
    const answering = (signals: unknown[], client = makeClient()) => {
      client.sendSignal = (async (signal: unknown) => {
        signals.push(signal);

        return { runId: "r" };
      }) as typeof client.sendSignal;

      return createAgentFunction(
        client,
        { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }), requests },
        async ({ inbox }) => {
          const seen: unknown[] = [];

          for (let i = 0; i < 2; i++) {
            const m = await inbox.next();
            if (m?.kind === "request") {
              seen.push(m.payload);
              await m.reply({
                answer: (m.payload as { n: number }).n * 2,
              });
            } else if (m) {
              seen.push(m.content);
            }
          }

          return seen;
        },
      );
    };

    test("a request that fits the schema is delivered and answered", async () => {
      const signals: unknown[] = [];

      const { output } = await run(answering(signals).fn, {
        event: message("request", undefined, "t1", {
          payload: { n: 21 },
          replyTo: "sig-1",
        }),
        saved: [message("user", "next")],
      });

      expect(output).toEqual([{ n: 21 }, "next"]);
      expect(signals).toEqual([{ signal: "sig-1", data: { answer: 42 } }]);
    });

    test("a request that breaks the schema is dropped, whether it started the run or came later", async () => {
      const signals: unknown[] = [];
      const client = makeClient();
      const warn = vi.spyOn(
        (client as unknown as Record<symbol, { warn: (m: string) => void }>)[
          Symbol.for("inngest.internalLogger")
        ] as { warn: (m: string) => void },
        "warn",
      );

      const { output } = await run(answering(signals, client).fn, {
        event: message("request", undefined, "t1", {
          payload: { n: "x" },
          replyTo: "sig-1",
        }),
        saved: [
          message("request", undefined, "t1", {
            payload: {},
            replyTo: "sig-2",
          }),
          message("request", undefined, "t1", { replyTo: "sig-4" }),
          message("user", "ok"),
          message("request", undefined, "t1", {
            payload: { n: 5 },
            replyTo: "sig-3",
          }),
        ],
      });

      expect(output).toEqual(["ok", { n: 5 }]);
      expect(signals).toEqual([{ signal: "sig-3", data: { answer: 10 } }]);

      // One warning per dropped request: the starting one, one with the wrong
      // shape and one with no payload at all.
      const dropped = warn.mock.calls.filter(([text]) => {
        return String(text).includes("Dropped agent/message");
      });

      expect(dropped).toHaveLength(3);
      expect(String(dropped[0]?.[0])).toContain("n:");
      warn.mockRestore();
    });

    test("a request without a payload is delivered when the schema allows it", async () => {
      const signals: unknown[] = [];
      const client = makeClient();
      client.sendSignal = (async (signal: unknown) => {
        signals.push(signal);

        return { runId: "r" };
      }) as typeof client.sendSignal;

      const { output } = await run(
        createAgentFunction(
          client,
          {
            id: "bot",
            kv: createKv({ adapter: memoryKvAdapter() }),
            requests: {
              request: z.object({ n: z.number() }).optional(),
              reply: z.object({ answer: z.string() }),
            },
          },
          async ({ inbox }) => {
            const m = await inbox.next();
            if (m?.kind !== "request") {
              return "not a request";
            }

            await m.reply({ answer: "no payload" });

            return m.payload ?? "undefined payload";
          },
        ).fn,
        { event: message("request", undefined, "t1", { replyTo: "sig-1" }) },
      );

      expect(output).toBe("undefined payload");
      expect(signals).toEqual([
        { signal: "sig-1", data: { answer: "no payload" } },
      ]);
    });

    test("an async schema works", async () => {
      const asyncRequests = {
        request: {
          "~standard": {
            version: 1,
            vendor: "test",
            validate: async (value: unknown) => {
              return { value: value as { n: number } };
            },
          },
        } as StandardSchemaV1<{ n: number }, { n: number }>,
        reply: {
          "~standard": {
            version: 1,
            vendor: "test",
            validate: async (value: unknown) => {
              return { value: value as { answer: number } };
            },
          },
        } as StandardSchemaV1<{ answer: number }, { answer: number }>,
      };
      const signals: unknown[] = [];
      const client = makeClient();
      client.sendSignal = (async (signal: unknown) => {
        signals.push(signal);

        return { runId: "r" };
      }) as typeof client.sendSignal;

      await run(
        createAgentFunction(
          client,
          {
            id: "bot",
            kv: createKv({ adapter: memoryKvAdapter() }),
            requests: asyncRequests,
          },
          async ({ inbox }) => {
            const m = await inbox.next();
            if (m?.kind === "request") {
              await m.reply({ answer: (m.payload as { n: number }).n });
            }
          },
        ).fn,
        {
          event: message("request", undefined, "t1", {
            payload: { n: 3 },
            replyTo: "sig-1",
          }),
        },
      );

      expect(signals).toEqual([{ signal: "sig-1", data: { answer: 3 } }]);
    });
  });

  test("a reply that does not fit the requests schema throws and sends nothing", async () => {
    const client = makeClient();
    const signals: unknown[] = [];
    client.sendSignal = (async (signal: unknown) => {
      signals.push(signal);

      return { runId: "r" };
    }) as typeof client.sendSignal;
    const { fn } = createAgentFunction(
      client,
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        requests: {
          request: staticSchema<{ n: number }>(),
          reply: z.object({ answer: z.number() }),
        },
      },
      async ({ inbox }) => {
        const m = await inbox.next();

        try {
          await m?.reply({ answer: "forty-two" } as never);
        } catch (error) {
          return (error as Error).message;
        }

        return "replied";
      },
    );

    const { output } = await run(fn, {
      event: message("request", undefined, "t1", {
        payload: { n: 21 },
        replyTo: "sig-1",
      }),
    });

    expect(output).toContain("message.reply() data");
    expect(signals).toEqual([]);
  });

  test("replying to a message that is not a request throws", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const m = await inbox.next();

        try {
          await m?.reply({});
        } catch (error) {
          return (error as Error).message;
        }

        return "replied";
      },
    );

    const { output } = await run(fn, { event: trigger("hi") });

    expect(output).toContain("not a request");
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
          prompt: first?.content ?? "",
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
          prompt: first?.content ?? "",
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
          await agent.invoke("team/leaf");
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
          await agent.invoke("team/leaf");
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

describe("scores", () => {
  const postScores = async (config: { scores?: boolean }) => {
    const seen: Record<string, Record<string, number>> = {};
    const { fn } = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv: createKv({ adapter: memoryKvAdapter() }),
        channels: { main: defineChannel({ post: async () => {} }) },
        ...config,
      },
      async ({ inbox, report }) => {
        await inbox.next();
        await report("one");
        await report("two");
      },
    );

    await run(fn, {
      event: { ...trigger("go"), ts: Date.now() - 50 } as ReturnType<
        typeof trigger
      >,
      onStep: (op) => {
        for (const update of op.metadata ?? []) {
          if (update.kind.startsWith("inngest.score.")) {
            seen[op.userland?.id ?? op.id] = {
              ...seen[op.userland?.id ?? op.id],
              [update.kind.slice("inngest.score.".length)]: (
                update.values as { value: number }
              ).value,
            };
          }
        }
      },
    });

    return seen;
  };

  test("the first post is scored from the trigger and the next from the first", async () => {
    const seen = await postScores({});

    expect(seen["report:1:0:main"]?.["agent.first_output_ms"]).toBeGreaterThan(
      49,
    );
    expect(seen["report:1:0:main"]?.["agent.output_gap_ms"]).toBeUndefined();
    expect(
      seen["report:2:0:main"]?.["agent.output_gap_ms"],
    ).toBeGreaterThanOrEqual(0);
    expect(seen["report:2:0:main"]?.["agent.first_output_ms"]).toBeUndefined();
  });

  test("scores: false writes no post scores", async () => {
    const seen = await postScores({ scores: false });

    expect(seen["report:1:0:main"]).toBeUndefined();
    expect(seen["report:2:0:main"]).toBeUndefined();
  });
});
