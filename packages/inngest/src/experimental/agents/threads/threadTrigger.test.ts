/**
 * @module
 * Tests for starting a thread from a trigger.
 */

import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgentFunction } from "../agent/agentFunction.ts";
import { run } from "../agent/test-helpers.ts";
import { createKv, memoryKvAdapter } from "../kv/kv.ts";
import { compileTriggers, singletonKey, startOf } from "./threadTrigger.ts";

const kv = createKv({ adapter: memoryKvAdapter() });

const chatThread =
  'event.data.room + "/" + (has(event.data.thread_ts) ? event.data.thread_ts : event.data.ts)';

const chatMessage = {
  name: "chat/message",
  id: "evt1",
  data: { room: "C1", thread_ts: "1.2", ts: "1.3", text: "hi" },
};

const makeClient = () => {
  return new Inngest({ id: testClientId });
};

const options = (fn: { opts?: unknown }) => {
  return (fn as unknown as { ["opts"]: unknown })["opts"] as {
    triggers: { event: string; if?: string }[];
    singleton: { key: string; mode: string };
  };
};

describe("thread key from a trigger", () => {
  test("with no triggers, the function is as before", () => {
    const agent = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async () => {},
    );
    const opts = agent.fn["opts"] as unknown as ReturnType<typeof options>;

    expect(
      opts.triggers.map((t) => {
        return t.event;
      }),
    ).toEqual(["agent/message", "agent/steer"]);
    expect(opts.singleton.key).toBe("event.data.thread");
  });

  test("the function triggers on the on events and keys its singleton on their expressions", () => {
    const agent = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv,
        triggers: [
          {
            event: "chat/message",
            if: "event.data.bot != true",
            thread: chatThread,
          },
          {
            event: "gh/comment",
            thread: 'event.data.repo + "#" + event.data.pr',
          },
        ],
      },
      async () => {},
    );
    const opts = agent.fn["opts"] as unknown as ReturnType<typeof options>;

    expect(opts.triggers).toEqual([
      expect.objectContaining({ event: "agent/message" }),
      expect.objectContaining({ event: "agent/steer" }),
      { event: "chat/message", if: "event.data.bot != true" },
      { event: "gh/comment" },
    ]);
    expect(opts.singleton.mode).toBe("skip");
    expect(opts.singleton.key).toBe(
      `event.name == "chat/message" ? ((has(event.data) && has(event.data.room)) ? (${chatThread}) : "fresh:" + event.id) : event.name == "gh/comment" ? ((has(event.data) && has(event.data.repo) && has(event.data.pr)) ? (event.data.repo + "#" + event.data.pr) : "fresh:" + event.id) : event.data.thread`,
    );
  });

  test("the run starts from the trigger event: its thread and a subscription per event", async () => {
    const seen: { event?: string; if?: string }[] = [];
    let message: unknown;
    const agent = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv,
        triggers: {
          event: "chat/message",
          if: "event.data.bot != true",
          thread: chatThread,
        },
      },
      async ({ inbox, me }) => {
        message = await inbox.next();

        return me.key;
      },
    );

    const { output } = await run(agent.fn, {
      event: chatMessage,
      onOp: (op) => {
        const opts = op.opts as { sources?: { event: string; if?: string }[] };

        seen.push(...(op.op === "Subscribe" ? (opts.sources ?? []) : []));
      },
    });

    expect(output).toBe("C1/1.2");
    expect(message).toMatchObject({
      name: "chat/message",
      id: "evt1",
      data: { room: "C1", text: "hi" },
    });

    const opened = seen;
    expect(
      opened.map((s) => {
        return s.event;
      }),
    ).toEqual(["agent/message", "agent/steer", "chat/message"]);
    expect(opened[0]?.if).toContain('async.data.thread == "C1/1.2"');
    expect(opened[2]?.if).toBe(
      `(event.data.bot != true) && (${chatThread}) == "C1/1.2"`.replaceAll(
        "event.",
        "async.",
      ),
    );
  });

  test("a message to the thread still starts it by its own thread", async () => {
    const agent = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv,
        triggers: { event: "chat/message", thread: chatThread },
      },
      async ({ inbox }) => {
        return (await inbox.next())?.data.thread;
      },
    );

    const { output } = await run(agent.fn, {
      event: {
        name: "agent/message",
        data: { agent: `${testClientId}/bot`, thread: "T9", text: "hi" },
      },
    });

    expect(output).toBe("T9");
  });

  test("the agent's thread option wins over the trigger's", () => {
    const [trigger] = compileTriggers("bot", {
      triggers: { event: "e", thread: '"ignored"' },
      thread: '"box:" + event.data.room',
    });

    expect(trigger?.thread.key({ data: { room: "C" } })).toBe("box:C");
    expect(singletonKey([trigger as never])).toContain('"box:"');
  });

  test("bad triggers are rejected when the agent is defined", () => {
    const define = (config: Record<string, unknown>) => {
      return () => {
        return createAgentFunction(
          makeClient(),
          { id: "bot", kv, ...config },
          async () => {},
        );
      };
    };

    expect(define({ triggers: { event: "e" } })).toThrow(
      /supplies no thread key/,
    );
    expect(define({ triggers: { event: "a/*", thread: '"t"' } })).toThrow(
      /(is a wildcard|owns)/,
    );
    expect(
      define({ triggers: { event: "agent/message", thread: '"t"' } }),
    ).toThrow(/(is a wildcard|owns)/);
    expect(
      define({
        triggers: [
          { event: "a", thread: '"t"' },
          { event: "a", thread: '"u"' },
        ],
      }),
    ).toThrow(/two triggers/);
    expect(
      define({ triggers: { event: "a", thread: "event.data.x[0]" } }),
    ).toThrow(/trigger "a"/);
  });
});

describe("a trigger with nothing at its thread path", () => {
  const [trigger] = compileTriggers("bot", {
    triggers: { event: "chat/message", thread: "event.data.room" },
  });

  test("starts a thread of its own, and marks the start", () => {
    const started = startOf("app/bot", trigger as never, {
      id: "evt-9",
      name: "chat/message",
      data: {},
    });

    expect(started.thread).toBe("fresh:evt-9");
    expect(started.fresh).toBe(true);
  });

  test("a path that is there keeps the key and marks nothing", () => {
    const started = startOf("app/bot", trigger as never, {
      id: "evt-9",
      name: "chat/message",
      data: { room: "C1" },
    });

    expect(started.thread).toBe("C1");
    expect(started).not.toHaveProperty("fresh");
  });
});
