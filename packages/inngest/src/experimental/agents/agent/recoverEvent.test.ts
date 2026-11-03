/**
 * @module
 * Tests for how a failed run is recovered: the in-flight message is sent
 * again as `agent/recover`, once per kind of error, never for a
 * `NonRetriableError`, and a fresh run takes it up.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { agentRecover } from "../inbox/events.ts";
import { kv } from "../kv/kv.ts";
import { compileTriggers } from "../threads/threadTrigger.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createFinishedFunction } from "./auxiliary.ts";
import { freshKv, run } from "./test-helpers.ts";
import type { AgentFunctionConfig } from "./types.ts";

beforeEach(() => {
  freshKv();
});

const ref = `${testClientId}/bot`;

/**
 * Runs the function that handles a run's ending, for a run that started with
 * `text` on thread `t1` and ended with `ending`, and returns the events it
 * sent.
 */
const ended = async (options: {
  config?: Partial<AgentFunctionConfig>;
  ending: Record<string, unknown>;
  runId?: string;

  /**
   * The text of the message the run was handling. Default `"hello"`.
   */
  text?: string;
}) => {
  const client = new Inngest({ id: testClientId });
  const config: AgentFunctionConfig = {
    id: "bot",
    recovery: true,
    ...options.config,
  };
  const finished = createFinishedFunction(
    client,
    config,
    ref,
    kv,
    compileTriggers("bot", config),
    () => {
      return false;
    },
  );
  const sent: { name: string; data: Record<string, unknown> }[] = [];

  Object.defineProperty(client, "_send", {
    value: async (input: { payload: unknown }) => {
      for (const event of [input.payload].flat()) {
        sent.push(event as (typeof sent)[number]);
      }

      return { ids: [], status: 200 };
    },
  });

  const start = {
    name: "agent/message",
    id: "evt-start",
    data: { agent: ref, thread: "t1", content: options.text ?? "hello" },
  };

  await run(finished, {
    event: {
      name: "inngest/function.finished",
      data: {
        function_id: `${testClientId}-bot`,
        run_id: options.runId ?? "01JRUN0000000000000000000A",
        events: [start],
        ...options.ending,
      },
    },
  });

  return sent;
};

describe("recovery resends as agent/recover", () => {
  test("a run that failed for good has its message sent again as agent/recover", async () => {
    const sent = await ended({
      ending: {
        _inngest: { status: "Failed" },
        error: { name: "Error", message: "boom" },
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(agentRecover.name);
    expect(sent[0]?.name).toBe("agent/recover");
    expect(sent[0]?.data).toMatchObject({
      agent: ref,
      thread: "t1",
      event: { name: "agent/message", data: { content: "hello" } },
    });
  });
});

describe("a fresh run takes up the recovered message", () => {
  test("agent/recover reaches the inbox as the message it was made from", async () => {
    const { fn } = createAgentFunction(
      new Inngest({ id: testClientId }),
      { id: "bot" },
      async ({ inbox }) => {
        const first = await inbox.next();

        return [first?.name, first?.data];
      },
    );
    const { output } = await run(fn, {
      event: {
        name: "agent/recover",
        data: {
          agent: ref,
          thread: "t1",
          event: {
            id: "evt9",
            name: "agent/message",
            data: { agent: ref, thread: "t1", content: "hello" },
          },
        },
      },
    });

    expect(output).toEqual([
      "agent/message",
      { agent: ref, thread: "t1", content: "hello" },
    ]);
  });
});
