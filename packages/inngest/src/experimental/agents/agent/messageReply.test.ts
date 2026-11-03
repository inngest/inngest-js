/**
 * @module
 * `message.reply()`: a run answers the sender of a message before it ends, with
 * an `agent/message.result` that carries the message's ID, so one live run can
 * serve many requests.
 */
import { z } from "zod/v4";
import { Inngest } from "../../../components/Inngest.ts";
import { invoke } from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { freshKv, run } from "./test-helpers.ts";

const sender = { kind: "function", id: "caller", key: "r0", depth: 1 };

const message = (id: string, content: unknown, from?: object) => {
  return {
    id,
    name: "agent/message",
    data: {
      agent: `${testClientId}/bot`,
      thread: "t1",
      content,
      ...(from && { from }),
    },
  };
};

const setup = () => {
  const sent: { name: string; data: Record<string, unknown>; id?: string }[] =
    [];
  const client = new Inngest({
    id: testClientId,
    eventKey: "key",
    fetch: (async (_url: unknown, init?: { body?: string }) => {
      sent.push(...JSON.parse(init?.body ?? "[]"));

      return new Response(JSON.stringify({ ids: ["1"], status: 200 }));
    }) as unknown as typeof fetch,
  });

  freshKv();

  return { client, sent };
};

describe("a run replies to each message it takes", () => {
  test("each reply is that message's result, sent before the run ends", async () => {
    const { client, sent } = setup();
    const agent = createAgentFunction(
      client,
      { id: "bot" },
      async ({ inbox }) => {
        for await (const m of inbox) {
          const content = (m.data as { content?: unknown }).content;
          await m.reply(`done ${String(content)}`);
        }

        return "ended";
      },
    );

    const { output } = await run(agent.fn, {
      event: message("m1", "one", sender),
      saved: [message("m2", "two", sender)],
    });

    expect(output).toBe("ended");
    expect(
      sent.filter((e) => {
        return e.name === "agent/message.result";
      }),
    ).toMatchObject([
      { data: { id: "m1", status: "completed", output: "done one" } },
      { data: { id: "m2", status: "completed", output: "done two" } },
    ]);
  });

  test("a reply to a message no one waits on sends nothing", async () => {
    const { client, sent } = setup();
    const agent = createAgentFunction(
      client,
      {
        id: "bot",
        triggers: [{ event: "app/ping" }],
        thread: "event.data.thread",
      },
      async ({ event, inbox }) => {
        for await (const m of inbox) {
          await m.reply("pong");
        }

        return event.name;
      },
    );

    await run(agent.fn, {
      event: { name: "app/ping", data: { thread: "t1" } },
    });

    expect(
      sent.filter((e) => {
        return e.name === "agent/message.result";
      }),
    ).toEqual([]);
  });

  test("serve answers each typed request with what its function returns, and returns the last", async () => {
    const { client, sent } = setup();
    const asked = invoke(z.object({ n: z.number() }));
    const typed = { ...sender, typed: true };
    const agent = createAgentFunction(
      client,
      { id: "bot", triggers: [asked], idle: "1m" },
      async ({ inbox }) => {
        return inbox.serve(asked, async ({ n }) => {
          return n * 2;
        });
      },
    );

    const { output } = await run(agent.fn, {
      event: message("m1", { n: 1 }, typed),
      saved: [message("m2", { n: 2 }, typed), message("m3", "chat", sender)],
      timeouts: 1,
    });

    expect(output).toBe(4);
    expect(
      sent.filter((e) => {
        return e.name === "agent/message.result";
      }),
    ).toMatchObject([
      { data: { id: "m1", output: 2 } },
      { data: { id: "m2", output: 4 } },
    ]);
  });
});
