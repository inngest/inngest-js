/**
 * @module
 * Tests for `agent.loop()`, with a scripted function standing in for the model.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod/v4";
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import type { OutgoingOp } from "../../types.ts";
import { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { step } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { type AgentTool, type SandboxTool, tool } from "../sandbox/tools.ts";
import {
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentMessage,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentToolRun,
  agent,
} from "./loop.ts";

const say = (text: string): AgentModelResponse => {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    toolCalls: [],
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
 * Plays the executor: runs a function until it resolves, running the steps it
 * finds one request at a time, or all at once when they are parallel, in the
 * order they were found (or reversed, to make later steps finish first).
 */
const drive = async (fn: InngestFunction.Any, reverse: boolean) => {
  const ran: string[] = [];
  const steps: OutgoingOp[] = [];
  let state: Parameters<typeof runFnWithStack>[1] = {};

  for (let request = 0; request < 40; request++) {
    const result = await runFnWithStack(fn, state);

    if (result.type !== "steps-found" && result.type !== "step-ran") {
      return { type: result.type, ran, steps };
    }

    const found = result.type === "step-ran" ? [result.step] : result.steps;

    for (const op of reverse ? [...found].reverse() : found) {
      const { step: done } =
        result.type === "step-ran"
          ? result
          : ((await runFnWithStack(fn, state, { runStep: op.id })) as {
              step: OutgoingOp;
            });

      steps.push(done);
      ran.push(done.userland?.id ?? done.id);
      state = {
        ...state,
        [done.id]: done.error
          ? { id: done.id, error: done.error }
          : { id: done.id, data: done.data },
      };
    }
  }

  throw new Error("The function did not finish");
};

/**
 * Runs the loop to the end with a model that answers from `script`, in order,
 * and returns what the model was asked and what the loop returned.
 */
const run = async (
  script: AgentModelResponse[],
  options: Partial<AgentLoopOptions> = {},
  reverse = false,
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
  const { type, ran, steps } = await drive(fn, reverse);

  return { type, ran, steps, requests, result };
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
      results: [
        {
          toolCallId: "id-add",
          name: "add",
          input: { a: 1, b: 2 },
          content: "3",
        },
      ],
    });
    expect(requests.map((request) => [request.turn, request.maxTurns])).toEqual(
      [
        [1, 40],
        [2, 40],
      ],
    );
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
      name: "a tool that returns an error",
      tools: {
        add: tool.step({
          input: z.object({}),
          run: () => {
            return agent.toolError({ error: "no such ticket", id: 7 });
          },
        }),
      },
      input: {},
      error: '{"error":"no such ticket","id":7}',
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

    expect(sent).toMatchObject({ role: "tool", results: [{ isError: true }] });
    expect(sent).toMatchObject({
      results: [{ content: expect.stringContaining(scenario.error) }],
    });
    expect(result?.stopped).toBe("done");
  });

  test.each([
    { name: "an unknown tool", call: "missing", input: {} },
    { name: "arguments that don't match", call: "add", input: { a: "x" } },
  ])(
    "reports a failed run of $name with the name the model sent",
    async (scenario) => {
      const { result } = await run(
        [call(scenario.call, scenario.input), say("ok")],
        { tools: { add } },
      );

      expect(result?.toolCalls).toHaveLength(1);
      expect(result?.toolCalls[0]).toMatchObject({
        isError: true,
        name: scenario.call,
        call: { name: scenario.call, input: scenario.input },
      });
    },
  );

  test("names a run by the tools record's key, not by the tool's own id", async () => {
    const renamed = tool({
      id: "original",
      input: z.object({ a: z.number() }),
      run: ({ a }) => {
        return a;
      },
    });
    const { requests, result } = await run(
      [call("renamed", { a: 1 }), say("ok")],
      { tools: { renamed } },
    );

    expect(requests[0]?.tools.map((definition) => definition.name)).toEqual([
      "renamed",
    ]);
    expect(result?.toolCalls[0]).toMatchObject({
      name: "renamed",
      isError: false,
      output: 1,
    });

    type Run = AgentToolRun<{ renamed: typeof renamed }>;
    const check = (item: Run) => {
      if (!item.isError) {
        expectTypeOf(item.name).toEqualTypeOf<"renamed">();
        expectTypeOf(item.output).toEqualTypeOf<unknown>();
      }
    };

    expect(check).toBeTypeOf("function");
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
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: "use bigger numbers",
    });
    expect(requests[2]?.messages.at(-1)?.role).toBe("tool");
  });

  test("runs onTurn after each model call, and it can use steps", async () => {
    const { ran, result } = await run(
      [call("add", { a: 1, b: 2 }), say("ok")],
      {
        onTurn: async ({ turn }) => {
          await step.run(`post:${turn}`, () => {
            return turn;
          });
        },
      },
    );

    expect(ran).toEqual([
      "agent:model:1",
      "post:1",
      "agent:1.0:add",
      "agent:model:2",
      "post:2",
    ]);
    expect(result?.stopped).toBe("done");
  });

  test("keeps a result with an error field of its own as a success", async () => {
    const { requests } = await run([call("add", {}), say("ok")], {
      tools: {
        add: tool.step({
          input: z.object({}),
          run: () => {
            return { error: null, value: 1 };
          },
        }),
      },
    });

    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      results: [
        {
          toolCallId: "id-add",
          name: "add",
          input: {},
          content: '{"error":null,"value":1}',
        },
      ],
    });
  });

  test("clips a tool result at maxToolOutput", async () => {
    const { requests } = await run([call("add", { a: 1, b: 2 }), say("ok")], {
      maxToolOutput: 1,
      tools: {
        add: tool.step({
          input: z.object({ a: z.number(), b: z.number() }),
          run: () => {
            return "abcdef";
          },
        }),
      },
    });

    expect(requests[1]?.messages.at(-1)).toMatchObject({
      results: [{ content: expect.stringContaining("clipped 5 characters") }],
    });
  });

  describe("a reply with several calls", () => {
    const two: AgentModelResponse = {
      message: { role: "assistant", content: "two calls" },
      toolCalls: [
        { id: "a", name: "add", input: { a: 1, b: 1 } },
        { id: "b", name: "add", input: { a: 2, b: 2 } },
      ],
    };

    test.each([
      { name: "in call order", reverse: false },
      {
        name: "in call order when the last call finishes first",
        reverse: true,
      },
    ])("gives the results in one message, $name", async ({ reverse }) => {
      const { requests, ran } = await run([two, say("ok")], {}, reverse);

      expect(ran[1]).toBe(reverse ? "agent:1.1:add" : "agent:1.0:add");
      expect(ran).toHaveLength(4);
      expect(requests[1]?.messages.at(-1)).toEqual({
        role: "tool",
        results: [
          { toolCallId: "a", name: "add", input: { a: 1, b: 1 }, content: "2" },
          { toolCallId: "b", name: "add", input: { a: 2, b: 2 }, content: "4" },
        ],
      });
    });

    test("keeps going when one call fails", async () => {
      const { requests, result } = await run([two, say("ok")], {
        tools: {
          add: tool.step({
            input: z.object({ a: z.number(), b: z.number() }),
            run: ({ a, b }) => {
              if (a === 1) {
                throw new NonRetriableError("first is down");
              }

              return a + b;
            },
          }),
        },
      });

      expect(requests[1]?.messages.at(-1)).toMatchObject({
        results: [
          { toolCallId: "a", isError: true },
          { toolCallId: "b", name: "add", input: { a: 2, b: 2 }, content: "4" },
        ],
      });
      expect(result?.stopped).toBe("done");
    });

    test("runs the calls one after another with parallelTools: false", async () => {
      const { ran } = await run([two, say("ok")], { parallelTools: false });

      expect(ran).toEqual([
        "agent:model:1",
        "agent:1.0:add",
        "agent:1.1:add",
        "agent:model:2",
      ]);
    });
  });

  test("runs a tool with a JSON Schema, and hands the schema to the model", async () => {
    const schema = {
      type: "object" as const,
      properties: { n: { type: "number" } },
      required: ["n"],
    };
    const { requests } = await run([call("double", { n: 4 }), say("ok")], {
      tools: {
        double: tool.step({
          input: schema,
          run: ({ n }) => {
            return (n as number) * 2;
          },
        }),
      },
    });

    expect(requests[0]?.tools).toEqual([
      { name: "double", input_schema: schema },
    ]);
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      results: [{ content: "8" }],
    });
  });

  test("tags model and tool steps with their span kinds", async () => {
    const { steps } = await run([call("add", { a: 1, b: 2 }), say("ok")]);

    expect(
      steps.map((op) => {
        return op.opts?.span;
      }),
    ).toEqual([
      [{ id: "agent:model:1", name: "Thinking", kind: "llm" }],
      [{ id: "agent:1.0:add", name: "add", kind: "tool" }],
      [{ id: "agent:model:2", name: "Thinking", kind: "llm" }],
    ]);
  });

  describe("steps inside a tool.group", () => {
    const fetchTwice = tool.group({
      input: z.object({ n: z.number() }),
      displayName: ({ n }) => {
        return `Fetch ${n}`;
      },
      run: async ({ n }) => {
        const first = await step.run("fetch", () => {
          return n;
        });

        // A tool in the middle of a nested scope keeps scoping by its call.
        return step.run("double", () => {
          return first * 2;
        });
      },
    });
    const two: AgentModelResponse = {
      message: { role: "assistant", content: "two calls" },
      toolCalls: [
        { id: "a", name: "fetchTwice", input: { n: 1 } },
        { id: "b", name: "fetchTwice", input: { n: 2 } },
      ],
    };

    test.each([
      { name: "in order", reverse: false },
      { name: "finishing in the other order", reverse: true },
    ])(
      "get the call's ID without the tool asking, $name",
      async ({ reverse }) => {
        const { ran, steps, requests } = await run(
          [two, say("ok")],
          { tools: { fetchTwice } },
          reverse,
        );

        expect([...ran].sort()).toEqual([
          "agent:1.0:fetchTwice:double",
          "agent:1.0:fetchTwice:fetch",
          "agent:1.1:fetchTwice:double",
          "agent:1.1:fetchTwice:fetch",
          "agent:model:1",
          "agent:model:2",
        ]);
        expect(
          steps.find((op) => {
            return op.userland?.id === "agent:1.1:fetchTwice:fetch";
          })?.displayName,
        ).toBe("fetch");
        expect(requests[1]?.messages.at(-1)).toMatchObject({
          results: [{ content: "2" }, { content: "4" }],
        });
      },
    );

    test("work the same one call at a time", async () => {
      const { ran } = await run([two, say("ok")], {
        tools: { fetchTwice },
        parallelTools: false,
      });

      expect(ran).toEqual([
        "agent:model:1",
        "agent:1.0:fetchTwice:fetch",
        "agent:1.0:fetchTwice:double",
        "agent:1.1:fetchTwice:fetch",
        "agent:1.1:fetchTwice:double",
        "agent:model:2",
      ]);
    });
  });

  test("indexes an ID a tool uses twice within its own call", async () => {
    const twice = tool.group({
      input: z.object({}),
      run: async () => {
        await step.run("t", () => {
          return 1;
        });

        return step.run("t", () => {
          return 2;
        });
      },
    });
    const { steps } = await run(
      [
        {
          message: { role: "assistant", content: "two calls" },
          toolCalls: [
            { id: "a", name: "twice", input: {} },
            { id: "b", name: "twice", input: {} },
          ],
        },
        say("ok"),
      ],
      { tools: { twice } },
      true,
    );

    const calls = steps.filter((op) => {
      return op.userland?.id?.includes("twice");
    });

    expect(calls.map((op) => op.userland?.id).sort()).toEqual([
      "agent:1.0:twice:t",
      "agent:1.0:twice:t",
      "agent:1.1:twice:t",
      "agent:1.1:twice:t",
    ]);
    expect(new Set(calls.map((op) => op.id)).size).toBe(4);
  });

  test.each([
    {
      name: "a string",
      displayName: "Look up",
      expected: "Look up",
    },
    {
      name: "a function of the input",
      displayName: ({ a }: { a: number }) => {
        return `Add ${a}`;
      },
      expected: "Add 1",
    },
  ])("names a tool's step with displayName as $name", async (scenario) => {
    const { steps } = await run([call("add", { a: 1, b: 2 }), say("ok")], {
      tools: {
        add: tool.step({
          input: z.object({ a: z.number(), b: z.number() }),
          displayName: scenario.displayName,
          run: ({ a, b }) => {
            return a + b;
          },
        }),
      },
    });
    const toolStep = steps.find((op) => {
      return op.userland?.id === "agent:1.0:add";
    });

    expect(toolStep?.displayName).toBe(scenario.expected);
    expect(toolStep?.opts?.span).toEqual([
      { id: "agent:1.0:add", name: scenario.expected, kind: "tool" },
    ]);
  });

  test("reports each tool call, and the model step's ID", async () => {
    const posted: string[] = [];
    const { ran, result } = await run(
      [call("add", { a: 1, b: 2 }), say("ok")],
      {
        onToolResult: async ({ stepId }) => {
          await step.run(`record`, () => {
            posted.push(stepId);
          });
        },
        onTurn: ({ turn, stepId }) => {
          posted.push(`${turn}=${stepId}`);
        },
      },
    );

    expect(ran).toContain("agent:1.0:add:record");
    expect(posted).toEqual(expect.arrayContaining(["1=agent:model:1"]));
    expect(result?.toolCalls).toEqual([
      {
        turn: 1,
        name: "add",
        call: { id: "id-add", name: "add", input: { a: 1, b: 2 } },
        output: 3,
        isError: false,
        stepId: "agent:1.0:add",
        ms: expect.any(Number),
      },
    ]);
  });

  test("gives onToolResult the body of an error result", async () => {
    const { result } = await run([call("add", {}), say("ok")], {
      tools: {
        add: tool.step({
          input: z.object({}),
          run: () => {
            return agent.toolError({ message: "no such ticket" });
          },
        }),
      },
    });

    expect(result?.toolCalls[0]).toMatchObject({
      output: { message: "no such ticket" },
      isError: true,
    });
  });

  test("sends the wrap-up text with no tool use on the last turn", async () => {
    const { requests, result } = await run(
      [call("add", { a: 1, b: 2 }), say("final answer")],
      { maxTurns: 2, wrapUp: "Write the answer now." },
    );

    expect(requests[0]).not.toHaveProperty("toolChoice");
    expect(requests[1]).toMatchObject({
      toolChoice: "none",
      tools: [expect.objectContaining({ name: "add" })],
    });
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: "Write the answer now.",
    });
    expect(result).toMatchObject({ stopped: "done", text: "final answer" });
  });

  describe("context", () => {
    const big = tool.step({
      input: z.object({}),
      run: () => {
        return "x".repeat(5_000);
      },
    });
    const script = [
      call("big", {}),
      call("big", {}),
      call("big", {}),
      call("big", {}),
      say("ok"),
    ];

    test("shortens old tool results by default and keeps the history whole", async () => {
      const { requests, result } = await run(script, {
        tools: { big },
        context: { maxChars: 8_000 },
      });
      const lengths = (index: number) => {
        return requests[index]?.messages.flatMap((message) => {
          return message.role === "tool"
            ? message.results.map((r) => r.content.length)
            : [];
        });
      };

      expect(lengths(4)?.[0]).toBeLessThan(300);
      expect(lengths(4)?.at(-1)).toBe(5_000);
      expect(
        result?.history.flatMap((message) => {
          return message.role === "tool"
            ? message.results.map((r) => r.content.length)
            : [];
        }),
      ).toEqual([5_000, 5_000, 5_000, 5_000]);
    });

    test("sends everything when it is off or under the budget", async () => {
      for (const context of [false as const, { maxChars: 1_000_000 }]) {
        const { requests } = await run(script, { tools: { big }, context });

        expect(
          requests[4]?.messages.flatMap((message) => {
            return message.role === "tool"
              ? message.results.map((r) => r.content.length)
              : [];
          }),
        ).toEqual([5_000, 5_000, 5_000, 5_000]);
      }
    });
  });

  test("continues from an earlier history", async () => {
    const first = await run([say("first")]);
    const { requests } = await run([say("second")], {
      history: first.result?.history,
      prompt: "again",
    });

    expect(
      requests[0]?.messages.map((m) => {
        return (m as { content: unknown }).content;
      }),
    ).toEqual(["go", [{ type: "text", text: "first" }], "again"]);
  });
});

describe("tool types", () => {
  const lookup = tool({
    id: "lookup",
    input: z.object({ id: z.string() }),
    output: z.object({ name: z.string() }),
    run: ({ id }) => {
      return { name: id };
    },
  });
  const ping = tool.step({
    run: () => {
      return "pong";
    },
  });
  const sum = tool.group({
    input: z.object({ values: z.array(z.number()) }),
    run: ({ values }) => {
      return values.length;
    },
  });

  test("tool() and tool.step() carry the schemas' types", () => {
    expectTypeOf(lookup).toEqualTypeOf<
      AgentTool<{ id: string }, { name: string }>
    >();
    expectTypeOf(sum).toEqualTypeOf<
      SandboxTool<{ values: number[] }, unknown>
    >();
    expectTypeOf(ping).toEqualTypeOf<SandboxTool<unknown, unknown>>();
  });

  test("a run that didn't fail narrows its input and output by the tool's name", () => {
    type Run = AgentToolRun<{ lookup: typeof lookup; sum: typeof sum }>;

    const check = (run: Run) => {
      if (run.isError) {
        expectTypeOf(run.name).toEqualTypeOf<string>();
        expectTypeOf(run.call.input).toEqualTypeOf<unknown>();
        expectTypeOf(run.output).toEqualTypeOf<unknown>();
      } else if (run.name === "lookup") {
        expectTypeOf(run.call.input).toEqualTypeOf<{ id: string }>();
        expectTypeOf(run.output).toEqualTypeOf<{ name: string }>();
      } else {
        expectTypeOf(run.name).toEqualTypeOf<"sum">();
        expectTypeOf(run.call.input).toEqualTypeOf<{ values: number[] }>();
      }
    };

    expect(check).toBeTypeOf("function");
  });

  test("untyped tools leave input and output unknown", () => {
    expectTypeOf<AgentToolRun["call"]["input"]>().toEqualTypeOf<unknown>();
    expectTypeOf<AgentToolRun["output"]>().toEqualTypeOf<unknown>();
    expectTypeOf<AgentToolRun["name"]>().toEqualTypeOf<string>();
  });

  // These call agent.loop, which needs a function execution, so they are only
  // compiled: the assertions are the types.
  test("agent.loop infers the tools from the call and types onToolResult", () => {
    const typecheck = async () => {
      const result = await agent.loop({
        model: agent.model(async () => {
          return say("done");
        }),
        prompt: "go",
        tools: { lookup },
        onToolResult: (run) => {
          if (!run.isError) {
            expectTypeOf(run.name).toEqualTypeOf<"lookup">();
            expectTypeOf(run.output).toEqualTypeOf<{ name: string }>();
          }
        },
      });

      expectTypeOf(result.toolCalls).toEqualTypeOf<
        AgentToolRun<{ lookup: typeof lookup }>[]
      >();
    };

    expect(typecheck).toBeTypeOf("function");
  });

  test("a typed result still fits a plain AgentLoopResult and AgentLoopOptions", () => {
    const typecheck = async () => {
      const result = await agent.loop({
        model: agent.model(async () => {
          return say("done");
        }),
        prompt: "go",
        tools: { lookup, sum, ping },
      });
      const plain: AgentLoopResult = result;
      const all: AgentLoopResult[] = [plain, result];
      const options: AgentLoopOptions = {
        model: agent.model(async () => {
          return say("done");
        }),
        prompt: "go",
        tools: { lookup },
      };

      return [all, options];
    };

    expect(typecheck).toBeTypeOf("function");
  });

  test("passing result.history back needs no annotation when history is declared as AgentMessage[]", () => {
    const typecheck = async () => {
      let history: AgentMessage[] = [];

      for (let turn = 0; turn < 2; turn += 1) {
        const result = await agent.loop({
          model: agent.model(async () => {
            return say("done");
          }),
          prompt: "go",
          tools: { lookup },
          history,
          onToolResult: (run) => {
            if (!run.isError) {
              expectTypeOf(run.name).toEqualTypeOf<"lookup">();
            }
          },
        });

        expectTypeOf(result.toolCalls).toEqualTypeOf<
          AgentToolRun<{ lookup: typeof lookup }>[]
        >();
        history = result.history;
      }
    };

    expect(typecheck).toBeTypeOf("function");
  });

  test("no tools still gives a result with failed runs", () => {
    const typecheck = async () => {
      const result = await agent.loop({
        model: agent.model(async () => {
          return say("done");
        }),
        prompt: "go",
        tools: {},
      });

      expectTypeOf<(typeof result.toolCalls)[number]>().toEqualTypeOf<
        AgentToolRun<{}>
      >();
      expectTypeOf<
        (typeof result.toolCalls)[number]["isError"]
      >().toEqualTypeOf<true>();
    };

    expect(typecheck).toBeTypeOf("function");
  });
});
