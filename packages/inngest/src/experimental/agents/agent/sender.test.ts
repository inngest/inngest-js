/**
 * @module
 * `msg.from`: who sent a message. An agent is a handle you can message back;
 * a plain function is an ID and a key, and cannot be messaged.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import { createAgents } from "./agents.ts";
import { run } from "./test-helpers.ts";

const make = () => {
  const client = new Inngest({ id: testClientId });
  const agents = createAgents(client, { store: memoryKvAdapter() });

  return agents.agent({ id: "bot" }, async ({ inbox }) => {
    const message = await inbox.next();

    if (message?.name !== "agent/message") {
      return "other";
    }

    const from = message.from;

    return from
      ? {
          kind: from.kind,
          key: from.key,
          address: from.kind === "agent" ? from.address : undefined,
          id: from.kind === "function" ? from.id : undefined,
          canMessage: typeof (from as { message?: unknown }).message,
        }
      : "none";
  });
};

const event = (from?: object) => {
  return {
    name: "agent/message",
    data: {
      agent: `${testClientId}/bot`,
      thread: "t1",
      content: "hi",
      ...(from && { from }),
    },
  };
};

describe("msg.from", () => {
  test("an agent sender is a handle on the sender's thread", async () => {
    const { fn } = make();
    const { output } = await run(fn, {
      event: event({ kind: "agent", address: "app/boss", key: "b1", depth: 1 }),
    });

    expect(output).toEqual({
      kind: "agent",
      key: "b1",
      address: "app/boss",
      canMessage: "function",
    });
  });

  test("a function sender is an id and a key and cannot be messaged", async () => {
    const { fn } = make();
    const { output } = await run(fn, {
      event: event({ kind: "function", id: "cron", key: "r1", depth: 1 }),
    });

    expect(output).toEqual({
      kind: "function",
      key: "r1",
      id: "cron",
      canMessage: "undefined",
    });
  });

  test("a message with no sender has no from", async () => {
    const { fn } = make();
    const { output } = await run(fn, { event: event() });

    expect(output).toBe("none");
  });
});

describe("me.message()", () => {
  test("puts a message in the agent's own inbox, from the agent, and resolves with nothing", async () => {
    const sent: { name: string; data: Record<string, unknown> }[] = [];
    const client = new Inngest({
      id: testClientId,
      eventKey: "key",
      fetch: (async (_url: unknown, init?: { body?: string }) => {
        sent.push(...JSON.parse(init?.body ?? "[]"));

        return new Response(JSON.stringify({ ids: ["1"], status: 200 }));
      }) as unknown as typeof fetch,
    });
    const agents = createAgents(client, { store: memoryKvAdapter() });
    const bot = agents.agent({ id: "bot" }, async ({ me }) => {
      return await me.message({ note: "remember" });
    });
    const { output } = await run(bot.fn, { event: event() });

    expect(output ?? undefined).toBeUndefined();
    expect(sent).toMatchObject([
      {
        name: "agent/message",
        data: {
          agent: `${testClientId}/bot`,
          thread: "t1",
          content: { note: "remember" },
          from: { kind: "agent", address: `${testClientId}/bot`, key: "t1" },
        },
      },
    ]);
  });
});
