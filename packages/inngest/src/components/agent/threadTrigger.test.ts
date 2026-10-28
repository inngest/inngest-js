/**
 * @module
 * Tests for starting a thread from a trigger.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { run } from "./test-helpers.ts";
import { compileTriggers, singletonKey } from "./threadTrigger.ts";

const kv = createKv({ adapter: memoryKvAdapter() });

const slackThread =
  'event.data.channel + "/" + (has(event.data.thread_ts) ? event.data.thread_ts : event.data.ts)';

const slackMessage = {
  name: "slack/message",
  id: "evt1",
  data: { channel: "C1", thread_ts: "1.2", ts: "1.3", text: "hi" },
};

const makeClient = () => {
  return new Inngest({ id: testClientId });
};

const options = (fn: { opts?: unknown }) => {
  return (fn as unknown as { ["opts"]: unknown })["opts"] as {
    triggers: { event: string; if?: string }[];
    singleton: { key: string; mode: string };
    cancelOn: { if: string }[];
  };
};

describe("thread key from a trigger", () => {
  test("with no on, the function is as before", () => {
    const agent = createAgentFunction(
      makeClient(),
      { id: "bot", kv },
      async () => {},
    );
    const opts = agent.fn["opts"] as unknown as ReturnType<typeof options>;

    expect(opts.triggers.map((t) => t.event)).toEqual(["agent/message"]);
    expect(opts.singleton.key).toBe("event.data.thread");
  });

  test("the function triggers on the on events and keys its singleton on their expressions", () => {
    const agent = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv,
        on: [
          {
            event: "slack/message",
            if: "event.data.bot != true",
            thread: slackThread,
          },
          {
            event: "gh/comment",
            thread: 'event.data.repo + "#" + string(event.data.pr)',
          },
        ],
      },
      async () => {},
    );
    const opts = agent.fn["opts"] as unknown as ReturnType<typeof options>;

    expect(opts.triggers).toEqual([
      expect.objectContaining({ event: "agent/message" }),
      { event: "slack/message", if: "event.data.bot != true" },
      { event: "gh/comment" },
    ]);
    expect(opts.singleton.mode).toBe("skip");
    expect(opts.singleton.key).toBe(
      `event.name == "slack/message" ? (${slackThread}) : event.name == "gh/comment" ? (event.data.repo + "#" + string(event.data.pr)) : event.data.thread`,
    );
    // Only a plain path of the trigger can be matched by a cancel expression.
    expect(opts.cancelOn).toHaveLength(1);
  });

  test("a thread key that is a plain path can be cancelled by a stop", () => {
    const agent = createAgentFunction(
      makeClient(),
      { id: "bot", kv, on: { event: "e", thread: "event.data.key" } },
      async () => {},
    );
    const opts = agent.fn["opts"] as unknown as ReturnType<typeof options>;

    expect(opts.cancelOn.map((c) => c.if)).toEqual([
      `event.data.agent == "${testClientId}/bot" && event.data.thread == async.data.thread`,
      `async.data.agent == "${testClientId}/bot" && event.data.key == async.data.thread`,
    ]);
  });

  test("the run starts from the trigger event: its thread, session, message and a subscription per event", async () => {
    const seen: { event?: string; if?: string }[] = [];
    let message: unknown;
    const agent = createAgentFunction(
      makeClient(),
      {
        id: "bot",
        kv,
        on: {
          event: "slack/message",
          if: "event.data.bot != true",
          thread: slackThread,
          session: '"slack:" + event.data.channel',
          message: (event) => {
            return event.data.text as string;
          },
        },
      },
      async ({ inbox, thread }) => {
        message = (await inbox.next())?.data;

        return thread.session;
      },
    );

    const { output } = await run(agent.fn, {
      event: slackMessage,
      onOp: (op) => {
        const opts = op.opts as { event?: string; if?: string };
        seen.push({ event: opts.event, if: opts.if });
      },
    });

    expect(output).toBe("slack:C1");
    expect(message).toMatchObject({
      agent: `${testClientId}/bot`,
      thread: "C1/1.2",
      kind: "user",
      content: "hi",
      event: { name: "slack/message", id: "evt1" },
    });

    const opened = seen.filter((s) => s.event);
    expect(opened.map((s) => s.event)).toEqual([
      "agent/message",
      "slack/message",
    ]);
    expect(opened[0]?.if).toContain('async.data.thread == "C1/1.2"');
    expect(opened[1]?.if).toBe(
      `(event.data.bot != true) && (${slackThread}) == "C1/1.2"`.replaceAll(
        "event.",
        "async.",
      ),
    );
  });

  test("a message to the thread still starts it by its own thread", async () => {
    const agent = createAgentFunction(
      makeClient(),
      { id: "bot", kv, on: { event: "slack/message", thread: slackThread } },
      async ({ inbox }) => {
        return (await inbox.next())?.data.thread;
      },
    );

    const { output } = await run(agent.fn, {
      event: {
        name: "agent/message",
        data: { agent: `${testClientId}/bot`, thread: "T9", kind: "user" },
      },
    });

    expect(output).toBe("T9");
  });

  test("the agent's thread and session options win over the trigger's", () => {
    const [trigger] = compileTriggers("bot", {
      on: { event: "e", thread: '"ignored"' },
      thread: '"box:" + event.data.channel',
      session: '"s1"',
    });

    expect(trigger?.thread.key({ data: { channel: "C" } })).toBe("box:C");
    expect(trigger?.session?.key({})).toBe("s1");
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

    expect(define({ on: { event: "e" } })).toThrow(/supplies no thread key/);
    expect(define({ on: { event: "a/*", thread: '"t"' } })).toThrow(
      /plain event name/,
    );
    expect(define({ on: { event: "agent/message", thread: '"t"' } })).toThrow(
      /plain event name/,
    );
    expect(
      define({
        on: [
          { event: "a", thread: '"t"' },
          { event: "a", thread: '"u"' },
        ],
      }),
    ).toThrow(/two triggers/);
    expect(define({ on: { event: "a", thread: "event.data.x[0]" } })).toThrow(
      /trigger "a"/,
    );
  });
});
