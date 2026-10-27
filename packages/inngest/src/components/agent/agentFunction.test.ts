/**
 * @module
 * Tests for the agent function and its cleanup companion.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { memoryInboxStore } from "./inbox.ts";
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

const makeClient = () => {
  return new Inngest({
    id: testClientId,
    eventKey: "test",
    fetch: async () => {
      return Response.json({ ids: ["x"], status: 200 });
    },
  });
};

const start = { name: "agent/start", data: { thread: "t1" } };

describe("agent function", () => {
  test("each inbox message is a turn, and the conversation carries across turns", async () => {
    const client = makeClient();
    const store = memoryInboxStore();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const prompts: string[][] = [];
    await store.append("t1", { kind: "user", content: "one" });
    await store.append("t1", { kind: "user", content: "two" });

    const { fn } = createAgentFunction(
      client,
      { id: "bot", event: "agent/start", store, kv },
      async ({ inbox, control }) => {
        let history: Parameters<typeof agent.loop>[0]["history"] = [];

        for await (const message of inbox) {
          const result = await agent.loop({
            id: `turn${message.seq}`,
            model: agent.model(async (request) => {
              prompts.push(
                request.messages.flatMap((m) => {
                  return m.role === "user" ? [m.content] : [];
                }),
              );

              return say(`ok ${message.seq}`);
            }),
            prompt: message.data.content,
            tools: {},
            history,
            ...control,
          });
          history = result.history;

          if (message.seq === 2) {
            return result.text;
          }
        }

        return null;
      },
    );

    const { output } = await run(fn, async () => false, start);

    expect(output).toBe("ok 2");
    expect(prompts).toEqual([["one"], ["one", "two"]]);
  });

  test("a message that arrives mid-turn is folded in, and the stop flag ends the loop", async () => {
    const client = makeClient();
    const store = memoryInboxStore();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const seen: string[][] = [];
    await store.append("t1", { kind: "user", content: "go" });
    await store.append("t1", { kind: "steer", content: "left" });
    await kv
      .at("thread", { env: "default", app: testClientId, thread: "t1" })
      .set("__stop", { when: "nextTurn" });

    const { fn } = createAgentFunction(
      client,
      { id: "bot", event: "agent/start", store, kv },
      async ({ inbox, control }) => {
        const first = (await inbox.next()) as { data: { content: string } };

        return agent.loop({
          model: agent.model(async (request) => {
            seen.push(
              request.messages.flatMap((m) => {
                return m.role === "user" ? [m.content] : [];
              }),
            );

            return {
              message: { role: "assistant", content: [] },
              toolCalls: [{ id: "c1", name: "missing", input: {} }],
              done: false,
            };
          }),
          prompt: first.data.content,
          tools: {},
          ...control,
        });
      },
    );

    const { output } = await run(fn, async () => false, start);

    expect(output).toMatchObject({ stopped: "stopped", turns: 1 });
    expect(seen).toEqual([["go"]]);
  });
});

describe("agent cleanup", () => {
  const finished = (error?: unknown) => {
    return {
      name: "inngest/function.finished",
      data: {
        run_id: "run1",
        function_id: `${testClientId}-bot`,
        event: start,
        ...(error ? { error } : {}),
      },
    };
  };

  test("clears run KV and hands the thread over when messages are unread", async () => {
    const client = makeClient();
    const store = memoryInboxStore();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const ids = { env: "default", app: testClientId };
    await kv.at("run", { ...ids, run: "run1" }).set("scratch", 1);
    await store.append("t1", { kind: "user", content: "late" });

    const { cleanup } = createAgentFunction(
      client,
      { id: "bot", event: "agent/start", store, kv },
      async () => {},
    );

    const { output, ran } = await run(cleanup, async () => false, finished());

    expect(output).toEqual({ handoff: true, head: 1 });
    expect(ran).toEqual(["clear-run-kv", "cursors", "handoff"]);
    expect(await kv.at("run", { ...ids, run: "run1" }).all()).toEqual({});
  });

  test("does not hand over a failed run or an empty inbox", async () => {
    const client = makeClient();
    const store = memoryInboxStore();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const { cleanup } = createAgentFunction(
      client,
      { id: "bot", event: "agent/start", store, kv },
      async () => {},
    );

    expect((await run(cleanup, async () => false, finished())).output).toEqual({
      handoff: false,
    });

    await store.append("t1", { kind: "user", content: "x" });

    expect(
      (await run(cleanup, async () => false, finished({ message: "boom" })))
        .output,
    ).toEqual({ handoff: false });
  });
});
