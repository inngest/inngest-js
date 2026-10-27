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
import { noRing, run } from "./test-helpers.ts";

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

const scoped = (key: string) => {
  return `${testClientId}:${key}`;
};

const start = { name: "agent/start", data: { thread: "t1" } };

describe("agent function", () => {
  test("each inbox message is a turn, and the conversation carries across turns", async () => {
    const client = makeClient();
    const store = memoryInboxStore();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const prompts: string[][] = [];
    await store.append(scoped("t1"), { kind: "user", content: "one" });
    await store.append(scoped("t1"), { kind: "user", content: "two" });

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

    const { output } = await run(fn, noRing, start);

    expect(output).toBe("ok 2");
    expect(prompts).toEqual([["one"], ["one", "two"]]);
  });

  test("a message that arrives mid-turn is folded in, and the stop flag ends the loop", async () => {
    const client = makeClient();
    const store = memoryInboxStore();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const seen: string[][] = [];
    await store.append(scoped("t1"), { kind: "user", content: "go" });
    await store.append(scoped("t1"), { kind: "steer", content: "left" });
    const threadState = kv.at("thread", {
      env: "default",
      app: testClientId,
      thread: "t1",
    });

    const { fn } = createAgentFunction(
      client,
      { id: "bot", event: "agent/start", store, kv },
      async ({ inbox, control }) => {
        const first = (await inbox.next()) as { data: { content: string } };

        return agent.loop({
          model: agent.model(async (request) => {
            // A stop request arrives while the run works.
            await threadState.set("__stop", { when: "nextTurn" });
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

    const { output } = await run(fn, noRing, start);

    expect(output).toMatchObject({ stopped: "stopped", turns: 1 });
    expect(seen).toEqual([["go"]]);
    // The request is consumed, so it does not stop the next loop too.
    expect(await threadState.get("__stop")).toBeUndefined();
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

  const setup = () => {
    const client = makeClient();
    const store = memoryInboxStore();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const ids = { env: "default", app: testClientId };
    const { cleanup } = createAgentFunction(
      client,
      { id: "bot", event: "agent/start", store, kv },
      async () => {},
    );

    return { store, kv, ids, cleanup };
  };

  test("clears run KV, the live marker and the stop flag", async () => {
    const { kv, ids, cleanup } = setup();
    const thread = kv.at("thread", { ...ids, thread: "t1" });
    await kv.at("run", { ...ids, run: "run1" }).set("scratch", 1);
    await thread.set("__run", { runId: "run1" });
    await thread.set("__stop", { when: "now" });
    await thread.set("keep", 1);

    const { output } = await run(cleanup, noRing, finished());

    expect(output).toEqual({ handoff: false, attempts: 0 });
    expect(await kv.at("run", { ...ids, run: "run1" }).all()).toEqual({});
    expect(await thread.all()).toEqual({ keep: 1 });
  });

  test("a newer live run keeps its marker and stop flag", async () => {
    const { kv, ids, cleanup } = setup();
    const thread = kv.at("thread", { ...ids, thread: "t1" });
    await thread.set("__run", { runId: "run2" });
    await thread.set("__stop", { when: "nextTurn" });

    await run(cleanup, noRing, finished());

    expect(await thread.get("__run")).toEqual({ runId: "run2" });
    expect(await thread.get("__stop")).toEqual({ when: "nextTurn" });
  });

  test.each([
    ["completed", undefined],
    ["failed", { message: "boom" }],
  ])(
    "a %s run with unread messages starts the next run",
    async (_name, error) => {
      const { store, cleanup } = setup();
      await store.append(scoped("t1"), { kind: "user", content: "late" });
      const starts: string[] = [];

      const { output } = await run(
        cleanup,
        noRing,
        finished(error),
        async (op) => {
          if (op.userland?.id === "handoff") {
            starts.push((op.opts as { id?: string } | undefined)?.id ?? "sent");
            // The next run takes the message.
            await store.claim(scoped("t1"), "next-run");
          }
        },
      );

      expect(output).toEqual({ handoff: true, attempts: 1 });
      expect(starts).toHaveLength(1);
    },
  );

  test("asks again, with a new event ID each time, while nobody takes the message", async () => {
    const { store, cleanup } = setup();
    await store.append(scoped("t1"), { kind: "user", content: "late" });
    const sends: unknown[] = [];

    const { output } = await run(cleanup, noRing, finished(), async (op) => {
      if (op.userland?.id === "handoff") {
        sends.push(op.id);
      }
    });

    expect(output).toEqual({ handoff: true, attempts: 5 });
    expect(new Set(sends).size).toBe(5);
  });

  test("does nothing for an empty inbox", async () => {
    const { cleanup } = setup();

    const { output, ran } = await run(cleanup, noRing, finished());

    expect(output).toEqual({ handoff: false, attempts: 0 });
    expect(ran).not.toContain("handoff");
  });
});
