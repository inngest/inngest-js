/**
 * @module
 * Tests for thread handles with a fake client.
 */
import { z } from "zod";
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { getThread, type ThreadRequests } from "./thread.ts";

const fakeClient = (
  cancelAnswer: { ok: boolean; error?: { error: string; status: number } } = {
    ok: true,
  },
) => {
  const sent: unknown[] = [];
  const cancelled: string[] = [];
  const client = {
    id: "app",
    env: null,
    async send(arg: unknown) {
      sent.push(arg);
    },
    inngestApi: {
      async cancelRun(runId: string) {
        cancelled.push(runId);

        return cancelAnswer;
      },
    },
  } as unknown as Inngest.Any;

  return { client, sent, cancelled };
};

import { StepOpCode } from "../../types.ts";

const sessions = { agent_session: "t1", agent_thread: "t1" };

describe("thread handle", () => {
  test("send and steer are agent/message events in the thread's sessions", async () => {
    const { client, sent } = fakeClient();
    const thread = getThread(client, "app/bot", "t1");

    await thread.send("hi");
    await thread.steer("faster");

    expect(sent).toMatchObject([
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

  test("stop nextTurn is a stop message", async () => {
    const { client, sent } = fakeClient();
    const thread = getThread(client, "app/bot", "t1");

    expect(await thread.stop({ when: "nextTurn" })).toEqual({ stopped: true });

    expect(sent).toMatchObject([
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
    ]);
  });

  test("stop now cancels the live run by its run ID, whatever the thread key looks like", async () => {
    const { client, sent, cancelled } = fakeClient();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const thread = getThread(client, "app/bot", "C1/1.2", { kv });
    const state = kv.with(client).scope("thread", "C1/1.2");

    // No record: nothing to cancel, and the answer says so.
    expect(await thread.stop({ when: "now" })).toEqual({ stopped: false });
    expect(cancelled).toEqual([]);

    await state.set("__state", { status: "waiting", turn: 0, runId: "run-1" });
    expect(await thread.stop({ when: "now" })).toEqual({ stopped: true });
    expect(cancelled).toEqual(["run-1"]);

    // A finished run is not cancelled again.
    await state.set("__state", { status: "idle", turn: 0, runId: "run-1" });
    expect(await thread.stop({ when: "now" })).toEqual({ stopped: false });
    expect(cancelled).toEqual(["run-1"]);
    expect(sent).toEqual([]);
  });

  test("a run that ended just before the cancel (404) is stopped; any other failure throws", async () => {
    const record = { status: "running", turn: 0, runId: "run-1" };
    const store = createKv({ adapter: memoryKvAdapter() });

    const gone = fakeClient({
      ok: false,
      error: { error: "not found", status: 404 },
    });
    await store.with(gone.client).scope("thread", "t1").set("__state", record);
    expect(
      await getThread(gone.client, "app/bot", "t1", { kv: store }).stop({
        when: "now",
      }),
    ).toEqual({ stopped: true });

    const broken = fakeClient({
      ok: false,
      error: { error: "server error", status: 500 },
    });
    await store
      .with(broken.client)
      .scope("thread", "t2")
      .set("__state", record);
    await expect(
      getThread(broken.client, "app/bot", "t2", { kv: store }).stop({
        when: "now",
      }),
    ).rejects.toThrow(/server error/);
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

  test("state shows the status the record holds, and idle for a thread with no record", async () => {
    const { client } = fakeClient();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const thread = getThread(client, "app/bot", "t1", { kv });
    const state = kv.with(client).scope("thread", "t1");
    const base = { turn: 1, usage: { input: 1, output: 1 } };

    expect((await thread.state()).status).toBe("idle");

    await state.set("__state", { ...base, status: "waiting", runId: "r1" });
    expect((await thread.state()).status).toBe("waiting");

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
      requests?: ThreadRequests["request"],
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
      const thread = getThread(client, `${testClientId}/bot`, "t1", {
        requests: requests && { request: requests, reply: requests },
      });
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

    test("request checks its payload against the requests schema before sending", async () => {
      const { fn, bodies } = setup(
        async (thread) => {
          return thread.request({ question: 7 } as never);
        },
        z.object({ question: z.string() }),
      );

      await expect(runFnWithStack(fn, {}, { event })).resolves.toMatchObject({
        type: "function-rejected",
      });
      expect(bodies).toEqual([]);
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
