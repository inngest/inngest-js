/**
 * @module
 * Tests for thread handles with a fake client and the in-memory stores.
 */
import type { Inngest } from "../Inngest.ts";
import { memoryInboxStore } from "./inbox.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { getThread } from "./thread.ts";

const fakeClient = (rings: boolean[]) => {
  const signals: unknown[] = [];
  const sent: unknown[] = [];
  const client = {
    id: "app",
    env: null,
    async sendSignal(arg: unknown) {
      signals.push(arg);

      return { runId: rings.shift() ? "run1" : undefined };
    },
    async send(arg: unknown) {
      sent.push(arg);
    },
  } as unknown as Inngest.Any;

  return { client, signals, sent };
};

const options = () => {
  return {
    startEvent: "agent/start",
    store: memoryInboxStore(),
    kv: createKv({ adapter: memoryKvAdapter() }),
    doorbellDelays: [0, 0],
  };
};

describe("thread handle", () => {
  test("send appends, rings the doorbell and does not start a run when a reader took it", async () => {
    const { client, signals, sent } = fakeClient([false, true]);
    const opts = options();
    const thread = getThread(client, "t1", opts);

    expect(await thread.send("hi")).toEqual({ seq: 1 });

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      signal: "inbox:default:app:t1",
      data: { seq: 1 },
    });
    expect(sent).toEqual([]);
    expect(await opts.store.claim("default:app:t1", "o")).toEqual({
      seq: 1,
      data: { kind: "user", content: "hi" },
    });
  });

  test("with no waiting run it starts one in the thread's sessions", async () => {
    const { client, signals, sent } = fakeClient([]);
    const thread = getThread(client, "t1", { ...options(), session: "s1" });

    await thread.steer("faster");

    expect(signals).toHaveLength(3);
    expect(sent).toEqual([
      {
        name: "agent/start",
        data: { thread: "t1" },
        meta: { sessions: { agent_session: "s1", agent_thread: "t1" } },
      },
    ]);
  });

  test("stops retrying once a reader has claimed the message", async () => {
    const { client, signals, sent } = fakeClient([]);
    const opts = options();
    const thread = getThread(client, "t1", opts);
    const originalSignal = client.sendSignal.bind(client);
    client.sendSignal = async (arg) => {
      await opts.store.claim("default:app:t1", "reader");

      return originalSignal(arg);
    };

    await thread.send("hi");

    expect(signals).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  test("stop does nothing without a live run", async () => {
    const { client, sent } = fakeClient([]);
    const opts = options();
    const thread = getThread(client, "t1", opts);

    await thread.stop({ when: "nextTurn" });
    await thread.stop({ when: "now" });

    expect(sent).toEqual([]);
    expect(
      await opts.kv
        .at("thread", { env: "default", app: "app", thread: "t1" })
        .all(),
    ).toEqual({});
  });

  test("stop sets the flag; now also cancels the run; state hides internal keys", async () => {
    const { client, sent } = fakeClient([]);
    const opts = options();
    const thread = getThread(client, "t1", opts);
    const state = opts.kv.at("thread", {
      env: "default",
      app: "app",
      thread: "t1",
    });
    await state.set("plan", [1]);
    await state.set("__run", { runId: "r1" });

    await thread.stop({ when: "nextTurn" });
    expect(sent).toEqual([]);
    expect(await state.get("__stop")).toEqual({ when: "nextTurn" });

    await thread.stop({ when: "now" });
    expect(sent).toEqual([
      { name: "agent/thread.stop", data: { thread: "t1" } },
    ]);
    expect(await thread.state()).toEqual({ plan: [1] });
  });
});
