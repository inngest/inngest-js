/**
 * @module
 * Tests for thread handles with a fake client.
 */

import { Inngest } from "../../../components/Inngest.ts";
import { runFnWithStack, testClientId } from "../../../test/helpers.ts";
import { freshKv } from "../agent/test-helpers.ts";
import { getThread } from "./thread.ts";

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

import { StepOpCode } from "../../../types.ts";

const sessions = { agent_session: "t1", agent_thread: "t1" };

describe("thread handle", () => {
  test("send and steer are agent/message and agent/steer events in the thread's sessions", async () => {
    const { client, sent } = fakeClient();
    const thread = getThread(client, "app/bot", "t1");

    await thread.send("hi");
    await thread.steer("faster");

    expect(sent).toMatchObject([
      {
        name: "agent/message",
        data: { agent: "app/bot", thread: "t1", text: "hi" },
        meta: { sessions },
      },
      {
        name: "agent/steer",
        data: { agent: "app/bot", thread: "t1", text: "faster" },
        meta: { sessions },
      },
    ]);
  });

  test("stop cancels the live run by its run ID, whatever the thread key looks like", async () => {
    const { client, sent, cancelled } = fakeClient();
    const kv = freshKv("app");
    const thread = getThread(client, "app/bot", "C1/1.2");
    const state = kv.with(client).scope("thread", "C1/1.2");

    // No record: nothing to cancel, and the answer says so.
    expect(await thread.stop()).toEqual({ stopped: false });
    expect(cancelled).toEqual([]);

    await state.set("__state", { status: "waiting", turn: 0, runId: "run-1" });
    expect(await thread.stop()).toEqual({ stopped: true });
    expect(cancelled).toEqual(["run-1"]);

    // A finished run is not cancelled again.
    await state.set("__state", { status: "idle", turn: 0, runId: "run-1" });
    expect(await thread.stop()).toEqual({ stopped: false });
    expect(cancelled).toEqual(["run-1"]);
    expect(sent).toEqual([]);
  });

  test("a run that ended just before the cancel (404) is stopped; any other failure throws", async () => {
    const record = { status: "running", turn: 0, runId: "run-1" };
    const store = freshKv("app");

    const gone = fakeClient({
      ok: false,
      error: { error: "not found", status: 404 },
    });
    await store.with(gone.client).scope("thread", "t1").set("__state", record);
    expect(await getThread(gone.client, "app/bot", "t1").stop()).toEqual({
      stopped: true,
    });

    const broken = fakeClient({
      ok: false,
      error: { error: "server error", status: 500 },
    });
    await store
      .with(broken.client)
      .scope("thread", "t2")
      .set("__state", record);
    await expect(
      getThread(broken.client, "app/bot", "t2").stop(),
    ).rejects.toThrow(/server error/);
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
            name: "agent/steer",
            data: { thread: "t1", text: "faster" },
            meta: { sessions },
          },
        ],
      ]);
    });
  });
});
