/**
 * @module
 * Tests for the agent function body against a fake executor.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { Middleware } from "../middleware/middleware.ts";
import { staticSchema } from "../triggers/triggers.ts";
import { createAgentFunction } from "./agentFunction.ts";
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
            prompt: m.data.content ?? "",
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
          prompt: first?.data.content ?? "",
          tools: {},
          ...control,
        });
        const next = await inbox.next();

        return [result.stopped, result.turns, next?.data.content];
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

  test("a stop message that arrives while waiting is skipped", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        const first = await inbox.next();
        const second = await inbox.next();

        return [first?.data.content, second?.data.content];
      },
    );

    const { output } = await run(fn, {
      event: trigger("a"),
      saved: [message("stop"), message("user", "b")],
    });

    expect(output).toEqual(["a", "b"]);
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

        return [first?.data.content, expired, second?.data.content];
      },
    );

    const { output } = await run(fn, {
      event: trigger("a"),
      incoming: [message("user", "b")],
      timeouts: 1,
    });

    expect(output).toEqual(["a", undefined, "b"]);
  });

  test("a message that arrives before the timeout is returned", async () => {
    const { fn } = createAgentFunction(
      makeClient(),
      { id: "bot", kv: createKv({ adapter: memoryKvAdapter() }) },
      async ({ inbox }) => {
        await inbox.next();
        const second = await inbox.next({ timeout: "30s" });

        return second?.data.content;
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

    expect(ops[0]).toEqual({ id: "inbox:open", mode: "open" });
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
          prompt: first?.data.content ?? "",
          tools: {},
          ...control,
        });
        const next = await inbox.next();

        return [result.stopped, next?.data.content];
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
      `${testClientId}-b`,
      `${testClientId}-b-cleanup`,
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
  const record = (kv: ReturnType<typeof createKv>) => {
    return kv
      .with({ id: testClientId, env: null })
      .scope("thread", "t1")
      .get("__state");
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
                ...say(`reply to ${m.data.content}`),
                usage: { input: 10, output: 5 },
              };
            }),
            prompt: m.data.content ?? "",
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

    expect([...seen.values()]).toEqual([
      {
        status: "running",
        turn: 1,
        summary: "reply to one",
        usage: { input: 10, output: 5 },
        runId: "run",
      },
      {
        status: "running",
        turn: 1,
        summary: "reply to two",
        usage: { input: 20, output: 10 },
        runId: "run",
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
          if (m.data.kind === "request") {
            await m.reply({ answer: (m.data.payload as { n: number }).n * 2 });

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
            if (m?.data.kind === "request") {
              seen.push(m.data.payload);
              await m.reply({
                answer: (m.data.payload as { n: number }).n * 2,
              });
            } else if (m) {
              seen.push(m.data.content);
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
            if (m?.data.kind !== "request") {
              return "not a request";
            }

            await m.reply({ answer: "no payload" });

            return m.data.payload ?? "undefined payload";
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
            if (m?.data.kind === "request") {
              await m.reply({ answer: (m.data.payload as { n: number }).n });
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
          prompt: first?.data.content ?? "",
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
