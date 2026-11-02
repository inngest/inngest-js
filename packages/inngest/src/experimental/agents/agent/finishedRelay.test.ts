/**
 * @module
 * Tests for the function that reports the end of a run a model started with
 * `start_agent`: it sends `agent/finished` to the starter's thread, for every
 * way a run can end, and ignores runs `start_agent` did not begin.
 */
import { Inngest } from "../../../components/Inngest.ts";
import { testClientId } from "../../../test/helpers.ts";
import { memoryKvAdapter } from "../kv/kv.ts";
import { createAgents } from "./agents.ts";
import { agentFinishedFunction } from "./finishedRelay.ts";
import { run } from "./test-helpers.ts";

const starter = {
  kind: "agent",
  address: `${testClientId}/parent`,
  key: "p1",
  depth: 1,
  thread: "c1",
  via: "start_agent",
  target: `${testClientId}/child`,
};

const finish = async (ending: Record<string, unknown>, from = starter) => {
  const client = new Inngest({ id: testClientId });
  const fn = agentFinishedFunction(client);
  const sent: { name: string; data: Record<string, unknown> }[] = [];

  Object.defineProperty(client, "_send", {
    value: async (input: { payload: unknown }) => {
      for (const event of [input.payload].flat()) {
        sent.push(event as (typeof sent)[number]);
      }

      return { ids: [], status: 200 };
    },
  });

  await run(fn, {
    event: {
      name: "inngest/function.finished",
      data: {
        function_id: `${testClientId}-child`,
        run_id: "01JRUN0000000000000000000A",
        events: [
          {
            name: "agent/message",
            id: "evt-start",
            data: {
              agent: `${testClientId}/child`,
              thread: "c1",
              content: "go",
              from,
            },
          },
        ],
        ...ending,
      },
    },
  });

  return sent;
};

describe("the finished relay", () => {
  test("trigger filters to runs start_agent began", () => {
    const fn = agentFinishedFunction(new Inngest({ id: testClientId }));

    expect(fn.opts.triggers).toEqual([
      {
        event: "inngest/function.finished",
        if: expect.stringContaining("start_agent"),
      },
    ]);
  });

  test("a completed run is reported with its output", async () => {
    expect(await finish({ result: { answer: 42 } })).toMatchObject([
      {
        name: "agent/finished",
        data: {
          agent: `${testClientId}/parent`,
          thread: "p1",
          outcome: "completed",
          output: { answer: 42 },
          from: { kind: "agent", address: `${testClientId}/child`, key: "c1" },
        },
      },
    ]);
  });

  test("a failed run is reported with its error", async () => {
    expect(
      await finish({
        error: { name: "Error", message: "boom" },
        _inngest: { status: "Failed" },
      }),
    ).toMatchObject([
      {
        name: "agent/finished",
        data: { thread: "p1", outcome: "failed", error: "boom" },
      },
    ]);
  });

  test("a cancelled run is reported as stopped", async () => {
    expect(await finish({ _inngest: { status: "Cancelled" } })).toMatchObject([
      { name: "agent/finished", data: { thread: "p1", outcome: "stopped" } },
    ]);
  });

  test("a run start_agent did not begin sends nothing", async () => {
    expect(
      await finish({ result: 1 }, { ...starter, via: undefined } as never),
    ).toEqual([]);
  });

  test("an app serves one, however many agents it defines", () => {
    const client = new Inngest({ id: testClientId });
    const agents = createAgents(client, { store: memoryKvAdapter() });

    agents.agent({ id: "one" });
    agents.agent({ id: "two" });

    expect(
      agents.functions().filter((fn) => {
        return fn.id(testClientId) === `${testClientId}-agents-finished`;
      }),
    ).toHaveLength(1);
  });
});
