/**
 * @module
 * Tests for the agent function body against a fake executor.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { type AgentModelResponse, agent } from "./loop.ts";
import { run } from "./test-helpers.ts";

const say = (text: string): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
    done: true,
  };
};

const message = (
  kind: "user" | "steer" | "stop",
  content?: string,
  thread = "t1",
) => {
  return {
    name: "agent/message",
    data: { agent: `${testClientId}/bot`, thread, kind, content },
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
        let history: Parameters<typeof agent.loop>[0]["history"] = [];
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
              done: false,
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

describe("agent cleanup", () => {
  test("a deferred function clears the run's run-scoped KV; the agent function registers it", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const { fn, cleanup, functions } = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async () => {},
    );
    expect(functions).toEqual([fn, cleanup]);

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
