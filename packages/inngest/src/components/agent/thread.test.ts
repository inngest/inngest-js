/**
 * @module
 * Tests for thread handles with a fake client.
 */
import type { Inngest } from "../Inngest.ts";
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

  test("state reads the thread KV and hides internal keys", async () => {
    const { client } = fakeClient();
    const kv = createKv({ adapter: memoryKvAdapter() });
    const thread = getThread(client, "app/bot", "t1", { kv });
    const state = kv.with(client).scope("thread", "t1");
    await state.set("plan", [1]);
    await state.set("__internal", 1);

    expect(await thread.state()).toEqual({ plan: [1] });
  });
});
