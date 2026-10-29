/**
 * @module
 * The fixed steps of an agent run: the thread record and the last run are
 * written by the steps that already run, and a turn's write rides in its model
 * call.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { type AgentModelResponse, agent } from "./loop.ts";
import { run } from "./test-helpers.ts";
import type { ThreadRecord } from "./thread.ts";
import { threadRecorder } from "./threadState.ts";

const toolTurn: AgentModelResponse = {
  message: { role: "assistant", content: [] },
  toolCalls: [{ id: "c1", name: "missing", input: {} }],
  usage: { input: 3, output: 2 },
};

const done: AgentModelResponse = {
  message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
  text: "ok",
  toolCalls: [],
  usage: { input: 4, output: 1 },
};

const trigger = {
  name: "agent/message",
  data: {
    agent: `${testClientId}/bot`,
    thread: "t1",
    kind: "user",
    content: "go",
  },
};

const build = (
  kv: ReturnType<typeof createKv>,
  turns: AgentModelResponse[],
) => {
  return createAgentFunction(
    new Inngest({ id: testClientId }),
    { id: "bot", kv },
    async ({ inbox, control, previousRun }) => {
      const first = await inbox.next();
      const result = await agent.loop({
        model: agent.model(async (request) => {
          return turns[request.turn - 1] as AgentModelResponse;
        }),
        prompt: first?.content ?? "",
        tools: {},
        ...control,
      });

      return [
        result.turns,
        previousRun ?? null,
        (await kv.thread.get("__state")) as ThreadRecord,
      ];
    },
  );
};

describe("steps of an agent run", () => {
  test("the start is one step and a turn's record adds none", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const { fn } = build(kv, [toolTurn, done]);
    const steps: string[] = [];

    const { output } = await run(fn, {
      event: trigger,
      onStep: (step) => {
        steps.push(step.userland?.id ?? step.id);
      },
    });
    const [turns, previous, record] = output as [number, unknown, ThreadRecord];

    expect([turns, previous]).toEqual([2, null]);

    // Only the body's own read is a KV step: the start and both turns wrote
    // the record without one.
    expect(steps.filter((id) => id.startsWith("kv."))).toEqual([
      "kv.get:thread:__state",
    ]);
    expect(steps).toContain("thread:start");
    expect(steps.filter((id) => id.includes(":model:"))).toHaveLength(2);

    // The record took in both turns, written inside their model steps.
    expect(record.turn).toBe(2);
    expect(record.usage).toEqual({ input: 7, output: 3 });
  });

  test("a turn recorded again, as a retried step would, is counted once", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const client = new Inngest({ id: testClientId });
    const fn = client.createFunction(
      { id: "recorder", triggers: [{ event: "agent/message" }] },
      async ({ runId }) => {
        const recorder = threadRecorder(kv, runId);
        const turn = {
          turn: 1,
          stepId: "m",
          text: "x",
          toolCalls: [],
          usage: { input: 2, output: 1 },
        };

        await recorder.turn(turn);

        return recorder.turn(turn);
      },
    );
    const { output } = await run(fn, { event: trigger });

    expect((output as ThreadRecord).usage).toEqual({ input: 2, output: 1 });
  });
});

describe("a run that began before these steps", () => {
  test("replays against its own steps: the old state writes, the per-source opens and the turn write", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const client = new Inngest({ id: testClientId });
    const { fn } = createAgentFunction(
      client,
      {
        id: "bot",
        kv,
        inbox: [
          { event: "extra/one", if: "true" },
          { event: "extra/two", if: "true" },
        ],
      },
      async ({ inbox, control }) => {
        const first = await inbox.next();
        const result = await agent.loop({
          model: agent.model(async () => {
            return done;
          }),
          prompt: first?.content ?? "",
          tools: {},
          ...control,
        });

        return result.turns;
      },
    );
    const record = (turn: number): ThreadRecord => {
      return {
        status: "running",
        turn,
        usage: { input: 4 * turn, output: turn },
        runId: "r",
      };
    };
    const written = (value: ThreadRecord) => {
      return { "~kvUpdate": true, value };
    };
    const steps: string[] = [];
    const ops: string[] = [];

    const { output } = await run(fn, {
      event: trigger,
      memos: {
        // The old shape of the start: a write, then a read.
        "kv.update:thread:__state": written(record(0)),
        "kv.get:thread:__lastRun": { "~kvRead": true, found: false },
        // Each source opened in its own step.
        "inbox:0:open": { opened: true },
        "inbox:1:open": { opened: true },
        "inbox:2:open": { opened: true },
        // The model call without a recorded turn, then its own write.
        "agent:model:1": done,
        "kv.update:thread:__state:1": written(record(1)),
      },
      onStep: (step) => {
        steps.push(step.userland?.id ?? step.id);
      },
      onOp: (op) => {
        ops.push(op.userland?.id ?? op.id);
      },
    });

    expect(output).toBe(1);
    // Nothing the run already did is asked again: no combined open, no turn
    // write, no model call.
    expect(ops).not.toContain("inbox:open:all");
    expect(ops.filter((id) => id.endsWith(":open"))).toEqual([]);
    expect(steps).not.toContain("agent:model:1");
    expect(steps).not.toContain("kv.update:thread:__state:1");
  });
});
