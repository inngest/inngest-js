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
import { agentToolSet } from "./agentTools.ts";
import { createAgents } from "./agents.ts";
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
  calls: { tool: string; input: Record<string, unknown> }[],
  options: Parameters<typeof agentToolSet>[0] = { functions: live },
) => {
  const tools = agentToolSet(options);
  const caller = agents.agent({ id: "caller" }, async () => {
    const out: unknown[] = [];

    for (const { tool, input } of calls) {
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
