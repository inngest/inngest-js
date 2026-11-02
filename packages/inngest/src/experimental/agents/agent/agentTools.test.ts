/**
 * @module
 * Tests for the model's agent tools: `start_agent`, `stop_agent` and `reply`.
 * None of them waits; what comes back reaches the model as a message.
 */
import { z } from "zod/v4";
import { Inngest } from "../../../components/Inngest.ts";
import { resolveToolCall } from "../../../components/sandbox/tools.ts";
import { invoke } from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import { threadKv, threadRecordKey } from "../threads/thread.ts";
import { createAgents } from "./agents.ts";
import { agentToolSet, sandboxAgentTools } from "./agentTools.ts";
import { run } from "./test-helpers.ts";

const client = new Inngest({ id: testClientId });
const agents = createAgents(client, { store: memoryKvAdapter() });

const plain = agents.agent({ id: "plain" });
const typed = agents.agent(
  { id: "typed", triggers: invoke(z.object({ topic: z.string() })) },
  async () => {
    return null;
  },
);

const live = async () => {
  return new Map([
    ["plain", { paused: false, archived: false }],
    ["typed", { paused: false, archived: false }],
    ["asleep", { paused: true, archived: false }],
  ]);
};

/**
 * Runs `calls` as the tools of a function and gives back each result, with the
 * invoke ops the run issued.
 */
const callTools = async (
  calls: {
    tool: string;
    input:
      | Record<string, unknown>
      | ((results: unknown[]) => Record<string, unknown>);
  }[],
  options: Parameters<typeof agentToolSet>[0] & { forSandbox?: boolean } = {
    functions: live,
  },
) => {
  const tools = options.forSandbox
    ? sandboxAgentTools(options)
    : agentToolSet(options);
  const caller = agents.agent({ id: "caller" }, async () => {
    const out: unknown[] = [];

    for (const { tool, input: given } of calls) {
      const input = typeof given === "function" ? given(out) : given;
      const resolved = await resolveToolCall(
        tools,
        { op: "call", id: 1, tool, args: [], kwargs: input },
        JSON.stringify(input),
      );

      if (resolved.error !== undefined) {
        out.push({ error: resolved.error });
        continue;
      }

      try {
        out.push(
          await resolved.invoke({
            signal: new AbortController().signal,
            idempotencyKey: "k",
          }),
        );
      } catch (error) {
        out.push({ error: String(error) });
      }
    }

    return out;
  });
  const invokes: { data: Record<string, unknown> }[] = [];
  const { output } = await run(caller.fn, {
    event: {
      name: "agent/message",
      data: { agent: `${testClientId}/caller`, thread: "c1", content: "go" },
    },
    onInvoke: (op) => {
      invokes.push((op.opts as { payload: { data: never } }).payload);

      return { data: "done" };
    },
  });

  return { results: output as unknown[], invokes };
};

beforeEach(() => {
  vi.spyOn(client, "queryInsights").mockRejectedValue(
    new Error("Insights query failed: 501 Not Implemented - no"),
  );
  vi.spyOn(client, "listEvents").mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("start_agent", () => {
  test("returns the thread's key at once and sends the input as an agent/message when the agent has no invoke() trigger", async () => {
    const { results, invokes } = await callTools([
      {
        tool: "start_agent",
        input: { address: plain.card.address, input: "write a poem" },
      },
    ]);

    expect(results).toEqual([{ thread: expect.any(String) }]);
    expect(invokes).toMatchObject([
      {
        data: {
          agent: plain.card.address,
          thread: (results[0] as { thread: string }).thread,
          content: "write a poem",
          from: {
            kind: "agent",
            address: `${testClientId}/caller`,
            key: "c1",
            via: "start_agent",
          },
        },
      },
    ]);
  });

  test("sends the input as the data of the invoke() trigger when the agent has one", async () => {
    const { invokes } = await callTools([
      {
        tool: "start_agent",
        input: { address: typed.card.address, input: { topic: "cats" } },
      },
    ]);

    expect(invokes).toMatchObject([{ data: { topic: "cats" } }]);
  });

  test("refuses an input that breaks the card's input before anything starts", async () => {
    const { results, invokes } = await callTools([
      {
        tool: "start_agent",
        input: { address: typed.card.address, input: { topic: 7 } },
      },
      { tool: "start_agent", input: { address: typed.card.address } },
    ]);

    expect(invokes).toEqual([]);
    expect(JSON.stringify(results[0])).toMatch(/topic/);
    expect(JSON.stringify(results[1])).toMatch(/topic/);
  });

  test("refuses a paused agent with a reason the model can read", async () => {
    const asleep = agents.agent({ id: "asleep" });
    const { results, invokes } = await callTools([
      { tool: "start_agent", input: { address: asleep.card.address } },
    ]);

    expect(invokes).toEqual([]);
    expect(JSON.stringify(results[0])).toMatch(/paused/);
  });

  test("refuses an address no agent is shared under", async () => {
    const { results, invokes } = await callTools([
      { tool: "start_agent", input: { address: "nobody/home" } },
    ]);

    expect(invokes).toEqual([]);
    expect(JSON.stringify(results[0])).toMatch(/list_agents/);
  });
});

describe("stop_agent", () => {
  const cancelled = () => {
    return vi
      .spyOn(
        (client as unknown as { inngestApi: { cancelRun: () => unknown } })
          .inngestApi,
        "cancelRun",
      )
      .mockResolvedValue({ ok: true } as never);
  };

  test("cancels the live run of the thread", async () => {
    const cancel = cancelled();

    await threadKv(client, "t-live").set(threadRecordKey, {
      runId: "run-1",
      status: "running",
    });

    const { results } = await callTools([
      { tool: "stop_agent", input: { thread: "t-live" } },
    ]);

    expect(results).toEqual([{ ok: true }]);
    expect(cancel).toHaveBeenCalledWith("run-1");
  });

  test("does nothing for a thread with no live run", async () => {
    const cancel = cancelled();

    await threadKv(client, "t-idle").set(threadRecordKey, {
      runId: "run-2",
      status: "idle",
    });

    const { results } = await callTools([
      { tool: "stop_agent", input: { thread: "t-idle" } },
      { tool: "stop_agent", input: { thread: "t-never" } },
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("the tools sandbox code gets", () => {
  test("hold start_agent and stop_agent plus the waiting agent_result", () => {
    const tools = sandboxAgentTools();

    expect(Object.keys(tools).sort()).toEqual([
      "agent_result",
      "start_agent",
      "stop_agent",
    ]);
    expect(tools.agent_result).toMatchObject({ group: true, waits: true });
  });

  test("the model's set leaves agent_result out", () => {
    expect("agent_result" in agentToolSet()).toBe(false);
  });

  test("agent_result gives the output of the run start_agent began, from the same invoke", async () => {
    const { results, invokes } = await callTools(
      [
        { tool: "start_agent", input: { address: plain.card.address } },
        {
          tool: "agent_result",
          input: (done) => {
            return { thread: (done[0] as { thread: string }).thread };
          },
        },
      ],
      { functions: live, forSandbox: true },
    );

    expect(invokes).toHaveLength(1);
    expect(results[1]).toEqual({ outcome: "completed", output: "done" });
  });

  test("agent_result names a thread this script did not start", async () => {
    const { results } = await callTools(
      [{ tool: "agent_result", input: { thread: "nope" } }],
      { functions: live, forSandbox: true },
    );

    expect(JSON.stringify(results[0])).toMatch(/nope/);
  });
});
