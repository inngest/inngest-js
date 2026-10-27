/**
 * @module
 * Tests for starting a thread from a trigger event.
 */
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";

const kv = createKv({ adapter: memoryKvAdapter() });

const slackMessage = {
  name: "slack/message",
  id: "evt1",
  data: { channel: "C1", thread_ts: "1.2", ts: "1.3", text: "hi" },
};

const sentBodies: unknown[][] = [];

const makeClient = () => {
  sentBodies.length = 0;

  return new Inngest({
    id: testClientId,
    eventKey: "key",
    fetch: (async (_url: unknown, init?: { body?: string }) => {
      sentBodies.push(JSON.parse(init?.body ?? "[]"));

      return new Response(JSON.stringify({ ids: ["id1"], status: 200 }), {
        status: 200,
      });
    }) as typeof fetch,
  });
};

const deliver = async (starter: Parameters<typeof runFnWithStack>[0]) => {
  await runFnWithStack(
    starter,
    {},
    { event: slackMessage, events: [slackMessage] },
  );

  return (sentBodies[0] ?? []) as {
    id: string;
    name: string;
    data: { thread: string };
    meta: unknown;
  }[];
};

describe("thread key from a trigger", () => {
  test("no on, no starter function", () => {
    const agent = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async () => {},
    );

    expect(agent.starter).toBeUndefined();
    expect(agent.functions).toHaveLength(2);
  });

  test("a trigger event becomes a message for its thread, stamped with the key and made idempotent by the event", async () => {
    const agent = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv,
        on: {
          event: "slack/message",
          thread: ({ event }) => {
            return `${event.data.channel}/${event.data.thread_ts ?? event.data.ts}`;
          },
          message: ({ event }) => {
            return event.data.text as string;
          },
        },
      },
      async () => {},
    );

    expect(agent.functions).toHaveLength(3);
    const sent = (await deliver(agent.starter as never))[0];

    expect(sent?.id).toBe("C1/1.2:evt1");
    expect(sent?.name).toBe("agent/message");
    expect(sent?.data).toMatchObject({
      agent: `${testClientId}/bot`,
      thread: "C1/1.2",
      kind: "user",
      content: "hi",
      event: { name: "slack/message" },
    });
    expect(sent?.meta).toEqual({
      sessions: { agent_session: "C1/1.2", agent_thread: "C1/1.2" },
    });
  });

  test("the agent's thread and session options win over the trigger's", async () => {
    const agent = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv,
        on: { event: "slack/message", thread: () => "ignored" },
        thread: async ({ event }) => {
          return `box:${event.data.channel}`;
        },
        session: "s1",
      },
      async () => {},
    );
    const sent = (await deliver(agent.starter as never))[0];

    expect(sent?.data.thread).toBe("box:C1");
    expect(sent?.meta).toEqual({
      sessions: { agent_session: "s1", agent_thread: "box:C1" },
    });
  });

  test("a trigger with no thread key and no agent thread is rejected when defined", () => {
    expect(() => {
      return createAgentFunction(
        makeClient(),
        { id: "bot", kv, on: { event: "slack/message" } },
        async () => {},
      );
    }).toThrow(/supplies no thread key/);
  });
});
