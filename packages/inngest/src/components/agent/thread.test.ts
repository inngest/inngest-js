/**
 * @module
 * Tests for thread handles with a fake client.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { getThread } from "./thread.ts";

const fakeClient = () => {
  const sent: unknown[] = [];
  const client = {
    id: "app",
    env: null,
    async send(arg: unknown) {
      sent.push(arg);
    },
  } as unknown as Inngest.Any;

  return { client, sent };
};

import { StepOpCode } from "../../types.ts";

const sessions = { agent_session: "t1", agent_thread: "t1" };

describe("thread handle", () => {
  test("send and steer are agent/message events in the thread's sessions", async () => {
    const { client, sent } = fakeClient();
    const thread = getThread(client, "app/bot", "t1");

    await thread.send("hi");
    await thread.steer("faster");

    expect(sent).toEqual([
      {
        name: "agent/message",
        data: { agent: "app/bot", thread: "t1", kind: "user", content: "hi" },
        meta: { sessions },
      },
      {
        name: "agent/message",
        data: {
          agent: "app/bot",
          thread: "t1",
          kind: "steer",
          content: "faster",
        },
        meta: { sessions },
      },
    ]);
  });

  test("a session other than the thread can be named", async () => {
    const { client, sent } = fakeClient();

    await getThread(client, "app/bot", "t1", { session: "s9" }).send("hi");

    expect(sent).toMatchObject([
      { meta: { sessions: { agent_session: "s9", agent_thread: "t1" } } },
    ]);
  });

  test("stop nextTurn is a stop message and stop now cancels the run", async () => {
    const { client, sent } = fakeClient();
    const thread = getThread(client, "app/bot", "t1");

    await thread.stop({ when: "nextTurn" });
    await thread.stop({ when: "now" });

    expect(sent).toEqual([
      {
        name: "agent/message",
        data: {
          agent: "app/bot",
          thread: "t1",
          kind: "stop",
          when: "nextTurn",
        },
        meta: { sessions },
      },
      { name: "agent/thread.stop", data: { agent: "app/bot", thread: "t1" } },
    ]);
  });

  test("state is the documented shape: status, turn, summary, usage and the user's keys", async () => {
    const { client } = fakeClient();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const thread = getThread(client, "app/bot", "t1", { kv });
    const state = kv.with(client).scope("thread", "t1");

    expect(await thread.state()).toEqual({
      status: "idle",
      turn: 0,
      summary: undefined,
      usage: { input: 0, output: 0 },
      keys: {},
    });

    await state.set("plan", [1]);
    await state.set("status", "mine");
    await state.set("__state", {
      status: "waiting",
      turn: 3,
      summary: "done so far",
      usage: { input: 30, output: 15 },
      runId: "r1",
    });

    expect(await thread.state()).toEqual({
      status: "waiting",
      turn: 3,
      summary: "done so far",
      usage: { input: 30, output: 15 },
      keys: { plan: [1], status: "mine" },
    });
  });

  test("a thread whose last run ended is idle, unless a newer run wrote the record or it was stopped", async () => {
    const { client } = fakeClient();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const thread = getThread(client, "app/bot", "t1", { kv });
    const state = kv.with(client).scope("thread", "t1");
    const base = { turn: 1, usage: { input: 1, output: 1 } };

    await state.set("__state", { ...base, status: "waiting", runId: "r1" });
    await state.set("__ended", "r1");
    expect((await thread.state()).status).toBe("idle");

    await state.set("__state", { ...base, status: "running", runId: "r2" });
    expect((await thread.state()).status).toBe("running");

    await state.set("__state", { ...base, status: "stopped", runId: "r1" });
    expect((await thread.state()).status).toBe("stopped");
  });

  test("request outside a function says why it cannot wait", async () => {
    const { client } = fakeClient();

    await expect(
      getThread(client, "app/bot", "t1").request({ question: "q" }),
    ).rejects.toThrow("inside a function");
  });

  describe("inside a function", () => {
    const event = { name: "go", data: {} };
    const setup = (
      body: (thread: ReturnType<typeof getThread>) => Promise<unknown>,
    ) => {
      const bodies: unknown[] = [];
      const client = new Inngest({
        id: testClientId,
        eventKey: "key",
        fetch: (async (_url: unknown, init?: { body?: string }) => {
          bodies.push(JSON.parse(init?.body ?? "null"));

          return new Response(JSON.stringify({ ids: ["1"], status: 200 }));
        }) as unknown as typeof fetch,
      });
      const thread = getThread(client, `${testClientId}/bot`, "t1");
      const fn = client.createFunction(
        { id: "caller", triggers: [{ event: "go" }] },
        async () => {
          return body(thread);
        },
      );

      return { fn, bodies };
    };

    test("steer is a step: it is sent from the step, with the thread's sessions", async () => {
      const { fn, bodies } = setup(async (thread) => {
        await thread.steer("faster");
      });

      const result = await runFnWithStack(fn, {}, { event });

      expect(result).toMatchObject({
        type: "step-ran",
        step: { op: StepOpCode.StepRun, displayName: "thread:t1:steer" },
      });
      expect(bodies).toMatchObject([
        [
          {
            name: "agent/message",
            data: { thread: "t1", kind: "steer", content: "faster" },
            meta: { sessions },
          },
        ],
      ]);
    });

    test("request sends the message and waits for the signal, wait first", async () => {
      const { fn } = setup(async (thread) => {
        return thread.request({ question: "q" }, { timeout: "5m" });
      });

      const result = await runFnWithStack(fn, {}, { event });

      expect(result).toMatchObject({
        type: "steps-found",
        steps: [
          {
            op: StepOpCode.WaitForSignal,
            opts: { signal: "thread-request:run:1", timeout: "5m" },
          },
          { displayName: "thread:t1:request" },
        ],
      });
    });

    test("request resolves to the reply, or null when the wait times out", async () => {
      const { fn } = setup(async (thread) => {
        return thread.request({ question: "q" });
      });
      const found = (await runFnWithStack(fn, {}, { event })) as {
        steps: { id: string }[];
      };
      const [waitId, sendId] = found.steps.map((step) => {
        return step.id;
      }) as [string, string];
      const sent = { id: sendId, data: { ids: ["1"] } };

      const answered = await runFnWithStack(
        fn,
        {
          [waitId]: {
            id: waitId,
            data: { signal: "thread-request:run:1", data: { answer: 42 } },
          },
          [sendId]: sent,
        },
        { event },
      );
      const timedOut = await runFnWithStack(
        fn,
        { [waitId]: { id: waitId, data: null }, [sendId]: sent },
        { event },
      );

      expect(answered).toMatchObject({
        type: "function-resolved",
        data: { answer: 42 },
      });
      expect(timedOut).toMatchObject({
        type: "function-resolved",
        data: null,
      });
    });
  });
});
