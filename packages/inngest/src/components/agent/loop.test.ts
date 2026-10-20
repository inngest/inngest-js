/**
 * @module
 * Tests for `agent.loop()`, with a scripted function standing in for the model.
 */
import { z } from "zod/v4";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { runToEnd } from "../sandbox/test-helpers.ts";
import { tool } from "../sandbox/tools.ts";
import {
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentModelRequest,
  type AgentModelResponse,
  agent,
} from "./loop.ts";

const say = (text: string): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
    done: true,
    usage: { input: 10, output: 5 },
  };
};

const call = (
  name: string,
  input: unknown,
  extra: unknown[] = [],
): AgentModelResponse => {
  return {
    message: {
      role: "assistant",
      content: [...extra, { type: "tool_use", id: `id-${name}`, name, input }],
    },
    toolCalls: [{ id: `id-${name}`, name, input }],
    done: false,
    usage: { input: 10, output: 5 },
  };
};

const add = tool.step({
  description: "Adds numbers",
  input: z.object({ a: z.number(), b: z.number() }),
  run: ({ a, b }) => {
    return a + b;
  },
});

/**
 * Runs the loop to the end with a model that answers from `script`, in order,
 * and returns what the model was asked and what the loop returned.
 */
const run = async (
  script: AgentModelResponse[],
  options: Partial<AgentLoopOptions> = {},
) => {
  const requests: AgentModelRequest[] = [];
  const client = new Inngest({ id: testClientId });
  let result: AgentLoopResult | undefined;

  const fn = client.createFunction(
    { id: "agent", triggers: [{ event: "agent/run" }] },
    async () => {
      result = await agent.loop({
        model: agent.model(async (request) => {
          requests.push(structuredClone(request));

          return script[requests.length - 1] as AgentModelResponse;
        }),
        prompt: "go",
        tools: { add },
        ...options,
      });
    },
  );
  const { type, ran } = await runToEnd(fn);

  return { type, ran, requests, result };
};

describe("agent.loop", () => {
  test("runs the model and its tools until the model is done", async () => {
    const { type, ran, requests, result } = await run([
      call("add", { a: 1, b: 2 }),
      say("It is 3"),
    ]);

    expect(type).toBe("function-resolved");
    expect(ran).toEqual(["agent:model:1", "agent:1.0:add", "agent:model:2"]);
    expect(requests[0]?.tools).toEqual([
      expect.objectContaining({ name: "add", description: "Adds numbers" }),
    ]);
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "id-add",
      content: "3",
    });
    expect(result).toMatchObject({
      text: "It is 3",
      stopped: "done",
      turns: 2,
      usage: { input: 20, output: 10 },
    });
    expect(result?.history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  test("stops at maxTurns", async () => {
    const { requests, result } = await run(
      [call("add", { a: 1, b: 1 }), call("add", { a: 2, b: 2 })],
      { maxTurns: 2 },
    );

    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({ stopped: "maxTurns", turns: 2 });
  });

  test.each([
    {
      name: "a tool that fails",
      tools: {
        add: tool.step({
          input: z.object({}),
          run: () => {
            throw new NonRetriableError("db is down");
          },
        }),
      },
      input: {},
      error: "db is down",
    },
    {
      name: "an unknown tool",
      tools: { add },
      input: {},
      call: "missing",
      error: "Unknown tool: missing",
    },
    {
      name: "arguments that don't match",
      tools: { add },
      input: { a: "x" },
      error: "Invalid arguments for add",
    },
  ])("gives the model $name as an error result", async (scenario) => {
    const { requests, result } = await run(
      [call(scenario.call ?? "add", scenario.input), say("ok")],
      { tools: scenario.tools },
    );
    const sent = requests[1]?.messages.at(-1);

    expect(sent).toMatchObject({ role: "tool", isError: true });
    expect(sent?.content).toContain(scenario.error);
    expect(result?.stopped).toBe("done");
  });

  test("keeps the model's message exactly as returned", async () => {
    const thinking = {
      type: "thinking",
      thinking: "hmm",
      signature: "sig-1",
    };
    const { requests } = await run([
      call("add", { a: 1, b: 2 }, [thinking]),
      say("done"),
    ]);

    expect(requests[1]?.messages[1]).toEqual({
      role: "assistant",
      content: [
        thinking,
        { type: "tool_use", id: "id-add", name: "add", input: { a: 1, b: 2 } },
      ],
    });
  });

  test("adds what steer returns after the tool results", async () => {
    const { requests } = await run(
      [call("add", { a: 1, b: 2 }), call("add", { a: 3, b: 4 }), say("ok")],
      {
        steer: async (turn) => {
          return turn === 1 ? ["use bigger numbers"] : undefined;
        },
      },
    );

    expect(requests[1]?.messages.slice(-2).map((m) => m.role)).toEqual([
      "tool",
      "user",
    ]);
    expect(requests[1]?.messages.at(-1)?.content).toBe("use bigger numbers");
    expect(requests[2]?.messages.at(-1)?.role).toBe("tool");
  });

  test("calls onTurn once per model call, and ignores its errors", async () => {
    const turns: number[] = [];
    const { result } = await run([call("add", { a: 1, b: 2 }), say("ok")], {
      onTurn: ({ turn }) => {
        turns.push(turn);

        throw new Error("sink is down");
      },
    });

    expect(turns).toEqual([1, 2]);
    expect(result?.stopped).toBe("done");
  });

  test("continues from an earlier history", async () => {
    const first = await run([say("first")]);
    const { requests } = await run([say("second")], {
      history: first.result?.history,
      prompt: "again",
    });

    expect(requests[0]?.messages.map((m) => m.content)).toEqual([
      "go",
      [{ type: "text", text: "first" }],
      "again",
    ]);
  });
});
