/**
 * @module
 * Tests for thread handles with a fake client.
 */

import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { freshKv } from "../agent/test-helpers.ts";
import { threadHandle } from "./thread.ts";

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

const sessions = { agent_session: "t1", agent_thread: "t1" };

describe("thread handle", () => {
  test("message outside a function throws and sends nothing", () => {
    const { client, sent } = fakeClient();
    const thread = threadHandle(client, "app/bot", "t1");

    expect(() => {
      thread.message("hi");
    }).toThrow(/inside an Inngest function.*trigger event/);
    expect(sent).toEqual([]);
  });

  test("stop cancels the live run by its run ID, whatever the thread key looks like", async () => {
    const { client, sent, cancelled } = fakeClient();
    const kv = freshKv("app");
    const thread = threadHandle(client, "app/bot", "C1/1.2");
    const state = kv.with(client).scope("thread", "C1/1.2");

    // No record: nothing to cancel, and the answer says so.
    await thread.stop();
    expect(cancelled).toEqual([]);

    await state.set("__state:app/bot", {
      status: "waiting",
      turn: 0,
      runId: "run-1",
    });
    await thread.stop();
    expect(cancelled).toEqual(["run-1"]);

    // A finished run is not cancelled again.
    await state.set("__state:app/bot", {
      status: "idle",
      turn: 0,
      runId: "run-1",
    });
    await thread.stop();
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
    await store
      .with(gone.client)
      .scope("thread", "t1")
      .set("__state:app/bot", record);
    await expect(
      threadHandle(gone.client, "app/bot", "t1").stop(),
    ).resolves.toBeUndefined();

    const broken = fakeClient({
      ok: false,
      error: { error: "server error", status: 500 },
    });
    await store
      .with(broken.client)
      .scope("thread", "t2")
      .set("__state:app/bot", record);
    await expect(
      threadHandle(broken.client, "app/bot", "t2").stop(),
    ).rejects.toThrow(/server error/);
  });

  describe("inside a function", () => {
    const event = { name: "go", data: {} };
    const setup = (
      body: (thread: ReturnType<typeof threadHandle>) => Promise<unknown>,
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
      const thread = threadHandle(client, `${testClientId}/bot`, "t1");
      const fn = client.createFunction(
        { id: "caller", triggers: [{ event: "go" }] },
        async () => {
          return body(thread);
        },
      );

      return { fn, bodies };
    };

    test("message is a step: it is sent from the step, with the thread's sessions", async () => {
      const { fn, bodies } = setup(async (thread) => {
        await thread.message("faster");
      });
      const { run } = await import("../agent/test-helpers.ts");

      await run(fn, { event, key: "msg:run.0", runId: "run" });

      expect(bodies).toMatchObject([
        [
          {
            id: "msg:run.0",
            name: "agent/message",
            data: { thread: "t1", content: "faster" },
            meta: { sessions },
          },
        ],
      ]);
    });
  });
});
