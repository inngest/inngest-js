/**
 * @module
 * Tests for `runLoop()`, with a scripted function standing in for the model.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod/v4";
import {
  getAsyncLocalStorage,
  runWithAsyncCtx,
} from "../../../components/execution/als.ts";
import { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import {
  type AgentTool,
  type SandboxTool,
  tool,
} from "../../../components/sandbox/tools.ts";
import { runFnWithStack, testClientId } from "../../../test/helpers.ts";
import type { OutgoingOp } from "../../../types.ts";
import { anthropic } from "./anthropic.ts";
import { compactionFor } from "./context.ts";
import {
  type AgentEvent,
  type AgentLoopInput,
  type AgentLoopOptions,
  type AgentLoopResult,
  type AgentLoopWiring,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentToolRun,
  agent,
  defaultMaxTurns,
  formatEvent,
  type ModelMessage,
} from "./loop.ts";
import { model, runLoop } from "./loopKit.ts";

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
  options: Partial<AgentLoopOptions> & {
    prompt?: AgentLoopInput;
    wiring?: AgentLoopWiring;
    onRequest?: (request: AgentModelRequest) => void;
  } = {},
  reverse = false,
) => {
  const { onRequest, ...loopOptions } = options;
  const requests: AgentModelRequest[] = [];
  const client = new Inngest({ id: testClientId });
  let result: AgentLoopResult | undefined;

  const fn = client.createFunction(
    { id: "agent", triggers: [{ event: "agent/run" }] },
    async () => {
      result = await runLoop({
        model: model(async (request) => {
          requests.push(structuredClone(request));
          onRequest?.(request);

          return script[requests.length - 1] as AgentModelResponse;
        }),
        prompt: "go",
        tools: { add },
        ...loopOptions,
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
      end: "done",
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
    expect(result).toMatchObject({ end: "maxTurns", turns: 2 });
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
    expect(result?.end).toBe("done");
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
        expectTypeOf(item.output).toEqualTypeOf<number>();
      }
    };

    expect(check).toBeTypeOf("function");
  });

  test("prices each model call with the price given, and reports it per turn and in the usage", async () => {
    const turns: unknown[] = [];
    const prices: unknown[] = [];
    const { result } = await run(
      [
        { ...call("add", { a: 1, b: 2 }), model: "claude-x" },
        { ...say("done"), model: "claude-y" },
      ],
      {
        price: (usage, model) => {
          prices.push([usage, model]);

          return 0.25;
        },
        onTurn: (turn) => {
          turns.push(turn.usage);
        },
      },
    );

    // The price runs in the model step (the harness may run a step twice).
    const distinct = (items: unknown[]) => {
      return [...new Set(items.map((item) => JSON.stringify(item)))];
    };

    expect(distinct(prices)).toEqual([
      JSON.stringify([{ input: 10, output: 5 }, "claude-x"]),
      JSON.stringify([{ input: 10, output: 5 }, "claude-y"]),
    ]);
    expect(distinct(turns)).toEqual([
      JSON.stringify({ input: 10, output: 5, usd: 0.25 }),
    ]);
    expect(result?.usage).toEqual({ input: 20, output: 10, usd: 0.5 });
  });

  test("the cost is stored on the model step, and a replay uses it without pricing again", async () => {
    let calls = 0;
    const price = () => {
      calls += 1;

      return calls;
    };
    const { steps, result } = await run([say("done")], { price });
    const modelStep = steps.find((done) => {
      return done.userland?.id === "agent:model:1";
    });

    expect(modelStep?.data).toMatchObject({ usd: 1 });
    expect(result?.usage.usd).toBe(1);
    expect(calls).toBe(1);

    // The step is memoized with its cost, and the price gives something else now.
    const client = new Inngest({ id: testClientId });
    const fn = client.createFunction(
      { id: "agent", triggers: [{ event: "agent/run" }] },
      async () => {
        result2 = await runLoop({
          model: model(async () => {
            throw new Error("the model must not be called on a replay");
          }),
          prompt: "go",
          tools: {},
          price,
        });
      },
    );
    let result2: AgentLoopResult | undefined;
    const state = Object.fromEntries(
      steps.map((done) => {
        return [done.id, { id: done.id, data: done.data }];
      }),
    );
    const replayed = await runFnWithStack(fn, state);

    expect(replayed.type).toBe("function-resolved");
    expect(result2?.usage.usd).toBe(1);
    expect(calls).toBe(1);
  });

  test("a model step memoized before costs were stored is priced when it replays", async () => {
    const { steps } = await run([say("done")], { price: () => 7 });
    const client = new Inngest({ id: testClientId });
    let replayed: AgentLoopResult | undefined;
    const fn = client.createFunction(
      { id: "agent", triggers: [{ event: "agent/run" }] },
      async () => {
        replayed = await runLoop({
          model: model(async () => {
            throw new Error("the model must not be called on a replay");
          }),
          prompt: "go",
          tools: {},
          price: () => 0.5,
        });
      },
    );
    const state = Object.fromEntries(
      steps.map((done) => {
        const { usd: _usd, ...old } = done.data as Record<string, unknown>;

        return [done.id, { id: done.id, data: old }];
      }),
    );
    const outcome = await runFnWithStack(fn, state);

    expect(outcome.type).toBe("function-resolved");
    expect(replayed?.usage.usd).toBe(0.5);
  });

  test("a stored cost that is not dollars is ignored and priced again", async () => {
    const { steps } = await run([say("done")], { price: () => 7 });
    const client = new Inngest({ id: testClientId });
    const seen: { replayed?: AgentLoopResult } = {};
    const usdOf = () => {
      return seen.replayed?.usage.usd;
    };
    const fn = client.createFunction(
      { id: "agent", triggers: [{ event: "agent/run" }] },
      async () => {
        seen.replayed = await runLoop({
          model: model(async () => {
            throw new Error("the model must not be called on a replay");
          }),
          prompt: "go",
          tools: {},
          price: () => 0.5,
        });
      },
    );

    for (const bad of [-1, Number.NaN, "7", null]) {
      const state = Object.fromEntries(
        steps.map((done) => {
          return [
            done.id,
            {
              id: done.id,
              data: { ...(done.data as Record<string, unknown>), usd: bad },
            },
          ];
        }),
      );

      seen.replayed = undefined;
      await runFnWithStack(fn, state);

      expect(usdOf()).toBe(0.5);
    }
  });

  test("a price that gives no dollars ends the run without a retry", async () => {
    const { steps } = await run([say("done")], { price: () => Number.NaN });

    expect(steps[0]).toMatchObject({
      op: "StepFailed",
      userland: { id: "agent:model:1" },
    });
  });

  test("prices from a table of rates per million tokens", async () => {
    const { result } = await run(
      [
        { ...call("add", { a: 1, b: 2 }), model: "claude-x" },
        { ...say("done"), model: "unlisted" },
      ],
      {
        price: {
          "claude-x": { input: 3_000_000, output: 15_000_000 },
          "*": { input: 1_000_000, output: 1_000_000 },
        },
      },
    );

    // 10 in and 5 out at $3 and $15 per token, then at $1 and $1.
    expect(result?.usage.usd).toBeCloseTo(10 * 3 + 5 * 15 + 10 + 5);
  });

  test("without a price the usage has no dollars", async () => {
    const { result } = await run([say("done")]);

    expect(result?.usage).toEqual({ input: 10, output: 5 });
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

  test("folds what arrives while a tool runs into the very next model call, in order and once", async () => {
    const waiting: AgentEvent[][] = [
      [],
      [1, 2, 3, 4, 5].map((n) => {
        return {
          id: `e${n}`,
          name: "agent/message",
          data: { content: `m${n}` },
        };
      }),
    ];
    const wiring: AgentLoopWiring = {
      drain: async ({ turn }) => {
        return waiting[turn - 1] ?? [];
      },
    };
    const { requests } = await run([call("add", { a: 1, b: 2 }), say("ok")], {
      wiring,
    });

    expect(requests[1]?.messages.slice(-6)).toEqual([
      expect.objectContaining({ role: "tool" }),
      { role: "user", content: "m1" },
      { role: "user", content: "m2" },
      { role: "user", content: "m3" },
      { role: "user", content: "m4" },
      { role: "user", content: "m5" },
    ]);
    expect(
      requests.flatMap((request) => {
        return request.messages.filter((message) => {
          return message.role === "user" && message.content === "m3";
        });
      }),
    ).toHaveLength(1);
  });

  test("folds before the first model call too", async () => {
    const waiting: AgentEvent[][] = [
      [{ id: "e1", name: "agent/message", data: { content: "early" } }],
    ];
    const { requests } = await run([say("ok")], {
      wiring: {
        drain: async ({ turn }) => {
          return waiting[turn - 1] ?? [];
        },
      },
    });

    expect(requests[0]?.messages).toEqual([
      { role: "user", content: "go" },
      { role: "user", content: "early" },
    ]);
  });

  test("a custom steer folds some messages and the rest come back as unread", async () => {
    const taken = [
      { id: "e1", name: "agent/message", data: { content: "keep" } },
      { id: "e2", name: "agent/message", data: { content: "later" } },
    ];
    const waiting: AgentEvent[][] = [taken];
    const seen: AgentEvent[][] = [];
    const { requests, result } = await run([say("ok")], {
      wiring: {
        drain: async ({ turn }) => {
          return waiting[turn - 1] ?? [];
        },
      },
      steer: async (drained) => {
        seen.push(drained);

        return drained.filter((message) => {
          return message.id === "e1";
        });
      },
    });

    expect(seen[0]).toEqual(taken);
    expect(requests[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: "keep",
    });
    expect(result?.unread).toEqual([taken[1]]);
  });

  test("an event as the prompt or a folded message is worded by the default format", async () => {
    const message = (name: string, data: unknown) => {
      return { id: "e1", name, data };
    };
    const waiting: AgentEvent[][] = [
      [],
      [
        message("agent/message", { content: "faster" }),
        message("ci/status", { state: "red" }),
      ],
    ];
    const { requests } = await run(
      [call("add", { a: 1, b: 2 }), call("add", { a: 3, b: 4 }), say("ok")],
      {
        prompt: message("agent/message", { content: "hello" }),
        wiring: {
          drain: async ({ turn }) => {
            return waiting[turn - 1] ?? [];
          },
        },
      },
    );

    expect(requests[0]?.messages[0]).toEqual({
      role: "user",
      content: "hello",
    });
    expect(requests[1]?.messages.slice(-2)).toEqual([
      { role: "user", content: "faster" },
      {
        role: "user",
        content: JSON.stringify({ event: "ci/status", data: { state: "red" } }),
      },
    ]);
  });

  test("format words events as text or content blocks, and blocks pass through as the prompt", async () => {
    const { requests } = await run([say("ok")], {
      prompt: { name: "chat/message", data: { text: "look", image: "u" } },
      format: (event) => {
        const data = event.data as { text: string; image: string };

        return [
          { type: "text", text: data.text },
          { type: "image", url: data.image },
        ];
      },
    });

    expect(requests[0]?.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", url: "u" },
      ],
    });

    const { requests: blocks } = await run([say("ok")], {
      prompt: [{ type: "text", text: "as given" }],
    });

    expect(blocks[0]?.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "as given" }],
    });
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

    expect([...ran].sort()).toEqual(
      [
        "agent:model:1",
        "agent:1.0:add",
        "agent:model:2",
        "post:1",
        "post:2",
      ].sort(),
    );
    expect(ran.indexOf("post:1")).toBeGreaterThan(ran.indexOf("agent:1.0:add"));
    expect(result?.end).toBe("done");
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
      expect(result?.end).toBe("done");
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
    const { result } = await run([call("add", { a: 1, b: 2 }), say("ok")], {
      onTurn: ({ turn, stepId }) => {
        posted.push(`${turn}=${stepId}`);
      },
    });

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

  test("gives the run the body of an error result", async () => {
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
    expect(result).toMatchObject({ end: "done", text: "final answer" });
  });

  describe("context", () => {
    const big = tool.step({
      input: z.object({}),
      run: () => {
        return "x".repeat(5_000);
      },
    });
    const bigLengths = (messages: ModelMessage[] | undefined) => {
      return messages?.flatMap((message) => {
        return message.role === "tool"
          ? message.results.map((r) => r.content.length)
          : [];
      });
    };
    const script = [
      call("big", {}),
      call("big", {}),
      call("big", {}),
      say("SUMMARY"),
      call("big", {}),
      say("ok"),
    ];

    test("sends the whole conversation by default", async () => {
      const { requests, result } = await run(
        [call("big", {}), call("big", {}), call("big", {}), say("ok")],
        { tools: { big } },
      );

      expect(bigLengths(requests[3]?.messages)).toEqual([5_000, 5_000, 5_000]);
      expect(result?.end).toBe("done");
    });

    test("each call sends the previous call's messages unchanged first", async () => {
      const { requests } = await run(
        [call("big", {}), call("big", {}), call("big", {}), say("ok")],
        { tools: { big } },
      );

      for (let index = 1; index < requests.length; index += 1) {
        const before = requests[index - 1]?.messages ?? [];

        expect(requests[index]?.messages.slice(0, before.length)).toEqual(
          before,
        );
      }
    });

    test("summarises the start once near the budget and keeps the history whole", async () => {
      const { requests, result } = await run(script, {
        tools: { big },
        compaction: { maxTokens: 4_000, keep: 2 },
      });
      const summarising = requests[3];

      expect(summarising?.tools).toEqual([]);
      expect(summarising?.messages).toHaveLength(1);
      expect(requests[4]?.messages).toHaveLength(3);
      expect(requests[4]?.messages[0]).toMatchObject({
        role: "user",
        content: expect.stringContaining("SUMMARY"),
      });
      expect(bigLengths(requests[4]?.messages)).toEqual([5_000]);
      expect(result?.history).toHaveLength(10);
      expect(bigLengths(result?.history)).toEqual([5_000, 5_000, 5_000, 5_000]);
    });

    test("a replay restores the summary and does not make another", async () => {
      const { requests } = await run(script, {
        tools: { big },
        compaction: { maxTokens: 4_000, keep: 2 },
      });

      // The function re-runs after every step; only the first run of the
      // model step called the model, and the later turns still start from
      // the stored summary.
      expect(requests).toHaveLength(6);
      expect(requests[5]?.messages[0]).toMatchObject({
        content: expect.stringContaining("SUMMARY"),
      });
      expect(requests[5]?.messages).toHaveLength(5);
    });

    test("counts the summary call's tokens in the turn", async () => {
      const { result } = await run(script, {
        tools: { big },
        compaction: { maxTokens: 4_000, keep: 2 },
      });

      // 6 model calls of 10 input and 5 output tokens each.
      expect(result?.usage).toMatchObject({ input: 60, output: 30 });
    });

    test("uses your own summariser", async () => {
      const { requests } = await run(
        [
          call("big", {}),
          call("big", {}),
          call("big", {}),
          call("big", {}),
          say("ok"),
        ],
        {
          tools: { big },
          compaction: {
            maxTokens: 4_000,
            keep: 2,
            summarise: async ({ messages }) => {
              return `mine of ${messages.length}`;
            },
          },
        },
      );

      expect(requests).toHaveLength(5);
      expect(requests[3]?.messages[0]).toMatchObject({
        content: expect.stringContaining("mine of 5"),
      });
    });

    test("keeps the conversation whole when the summary comes back empty", async () => {
      const { requests } = await run(
        [call("big", {}), call("big", {}), call("big", {}), say(""), say("ok")],
        { tools: { big }, compaction: { maxTokens: 4_000, keep: 2 } },
      );

      expect(requests[4]?.messages).toHaveLength(7);
    });

    test("never cuts between a reply and its tool results", async () => {
      const { requests } = await run(
        [
          call("big", {}),
          call("big", {}),
          call("big", {}),
          say("S"),
          say("ok"),
        ],
        { tools: { big }, compaction: { maxTokens: 4_000, keep: 1 } },
      );
      const summarised = requests[4]?.messages ?? [];

      expect(summarised[1]?.role).not.toBe("tool");
    });
  });

  describe("long tool output", () => {
    const long = tool.step({
      input: z.object({}),
      run: () => {
        return "y".repeat(200_000);
      },
    });

    test("keeps up to 100000 characters by default, then says what is missing", async () => {
      const { requests } = await run([call("long", {}), say("ok")], {
        tools: { long },
      });
      const result = (
        requests[1]?.messages.at(-1) as { results: { content: string }[] }
      ).results[0]?.content;

      expect(result).toContain("clipped 100000 characters");
    });

    test("falls back to the clipped text when saving fails", async () => {
      const { requests } = await run([call("long", {}), say("ok")], {
        tools: { long },
        spill: {
          sandbox: {
            files: {
              write: async () => {
                throw new Error("no such dir");
              },
              read: async () => new Uint8Array(),
            },
          },
        },
      });

      expect(JSON.stringify(requests[1]?.messages.at(-1))).toContain(
        "could not be saved: no such dir",
      );
    });

    test("saves the whole output to a sandbox file with spill", async () => {
      const writes: { path: string; data: string | Uint8Array }[] = [];
      const { requests } = await run([call("long", {}), say("ok")], {
        tools: { long },
        spill: {
          sandbox: {
            files: {
              write: async (id, file) => {
                await step.run(id as string, () => {
                  writes.push(file);
                });
              },
              read: async () => new Uint8Array(),
            },
          },
        },
      });
      const result = (
        requests[1]?.messages.at(-1) as { results: { content: string }[] }
      ).results[0]?.content;

      expect(writes).toHaveLength(1);
      expect(writes[0]?.data).toHaveLength(200_000);
      expect(result).toContain(`saved in the sandbox at ${writes[0]?.path}`);
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
      SandboxTool<{ values: number[] }, number>
    >();
    expectTypeOf(ping).toEqualTypeOf<
      SandboxTool<Record<string, never>, string>
    >();
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
  test("agent.loop infers the tools from the call", () => {
    const typecheck = async () => {
      const result = await runLoop({
        model: model(async () => {
          return say("done");
        }),
        prompt: "go",
        tools: { lookup },
      });

      expectTypeOf(result.toolCalls).toEqualTypeOf<
        AgentToolRun<{ lookup: typeof lookup }>[]
      >();
    };

    expect(typecheck).toBeTypeOf("function");
  });

  test("a typed result still fits a plain AgentLoopResult and AgentLoopOptions", () => {
    const typecheck = async () => {
      const result = await runLoop({
        model: model(async () => {
          return say("done");
        }),
        prompt: "go",
        tools: { lookup, sum, ping },
      });
      const plain: AgentLoopResult = result;
      const all: AgentLoopResult[] = [plain, result];
      const options: AgentLoopOptions = {
        model: model(async () => {
          return say("done");
        }),
        tools: { lookup },
      };

      return [all, options];
    };

    expect(typecheck).toBeTypeOf("function");
  });

  test("passing result.history back needs no annotation when history is declared as ModelMessage[]", () => {
    const typecheck = async () => {
      let history: ModelMessage[] = [];

      for (let turn = 0; turn < 2; turn += 1) {
        const result = await runLoop({
          model: model(async () => {
            return say("done");
          }),
          prompt: "go",
          tools: { lookup },
          history,
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
      const result = await runLoop({
        model: model(async () => {
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

const scoresOf = (op: OutgoingOp | undefined) => {
  return Object.fromEntries(
    (op?.metadata ?? [])
      .filter((update) => {
        return update.kind.startsWith("inngest.score.");
      })
      .map((update) => {
        return [
          update.kind.slice("inngest.score.".length),
          (update.values as { value: number }).value,
        ];
      }),
  );
};

describe("agent.loop scores", () => {
  const stepNamed = (steps: OutgoingOp[], id: string) => {
    return steps.find((op) => {
      return op.userland?.id === id;
    });
  };

  test("scores each model and tool step with that step's own result", async () => {
    const { steps } = await run([call("add", { a: 1, b: 2 }), say("It is 3")]);

    expect(scoresOf(stepNamed(steps, "agent:model:1"))).toEqual({
      "agent.model_ms": expect.any(Number),
      "agent.tool_calls": 1,
      "agent.steers": 0,
      "agent.input_tokens": 10,
      "agent.output_tokens": 5,
    });
    expect(scoresOf(stepNamed(steps, "agent:1.0:add"))).toEqual({
      "agent.tool_ms": expect.any(Number),
      "agent.tool_error": 0,
    });
    expect(scoresOf(stepNamed(steps, "agent:model:2"))).toMatchObject({
      "agent.tool_calls": 0,
    });
  });

  test("scores a tool that returns toolError() as an error", async () => {
    const failing = tool.step({
      description: "Fails",
      input: z.object({}),
      run: () => {
        return agent.toolError({ message: "nope" });
      },
    });
    const { steps } = await run([call("failing", {}), say("a")], {
      tools: { failing },
    });

    expect(scoresOf(stepNamed(steps, "agent:1.0:failing"))).toMatchObject({
      "agent.tool_error": 1,
    });
  });

  test("a tool with an output schema may return toolError(), scored as an error and not checked against the schema", async () => {
    const lookup = tool.step({
      description: "Looks a ticket up",
      input: z.object({ id: z.number() }),
      output: z.object({ title: z.string() }),
      run: ({ id }) => {
        if (id < 0) {
          return agent.toolError({ message: "no such ticket", id });
        }

        return { title: "ok" };
      },
    });
    const { steps } = await run([call("lookup", { id: -1 }), say("a")], {
      tools: { lookup },
    });

    expect(scoresOf(stepNamed(steps, "agent:1.0:lookup"))).toMatchObject({
      "agent.tool_error": 1,
    });
  });

  test("counts the messages folded into a model call", async () => {
    const waiting: AgentEvent[][] = [
      [],
      [
        { id: "e1", name: "agent/message", data: { content: "use 2" } },
        { id: "e2", name: "agent/message", data: { content: "and 3" } },
      ],
    ];
    const { steps } = await run([call("add", { a: 1, b: 2 }), say("done")], {
      wiring: {
        drain: async ({ turn }) => {
          return waiting[turn - 1] ?? [];
        },
      },
    });

    expect(scoresOf(stepNamed(steps, "agent:model:1"))).toMatchObject({
      "agent.steers": 0,
    });
    expect(scoresOf(stepNamed(steps, "agent:model:2"))).toMatchObject({
      "agent.steers": 2,
    });
  });

  test("tools are optional: a loop with none just answers", async () => {
    const { type, ran, requests } = await run([say("hi")], {
      tools: undefined,
    });

    expect(type).toBe("function-resolved");
    expect(ran).toEqual(["agent:model:1"]);
    expect(requests[0]?.tools).toEqual([]);
  });

  test("a second loop with the same prefix in one run gets its own step IDs", async () => {
    const client = new Inngest({ id: testClientId });
    const answers = [say("one"), say("two"), say("three"), say("four")];
    let used = 0;
    const scripted = model(async () => {
      return answers[used++] as AgentModelResponse;
    });
    const texts: string[] = [];

    const fn = client.createFunction(
      { id: "agent", triggers: [{ event: "agent/run" }] },
      async () => {
        for (const options of [{}, {}, { id: "named" }, { id: "named" }]) {
          const { text } = await runLoop({
            model: scripted,
            prompt: "go",
            ...options,
          });

          texts.push(text);
        }
      },
    );
    const { type, ran } = await drive(fn, false);

    expect(type).toBe("function-resolved");
    expect(ran).toEqual([
      "agent:model:1",
      "agent-2:model:1",
      "named:model:1",
      "named-2:model:1",
    ]);
    expect(texts.slice(-4)).toEqual(["one", "two", "three", "four"]);
  });

  test("loops running side by side get distinct prefixes too", async () => {
    const client = new Inngest({ id: testClientId });
    const scripted = model(async () => {
      return say("ok");
    });

    const fn = client.createFunction(
      { id: "agent", triggers: [{ event: "agent/run" }] },
      async () => {
        await Promise.all([
          runLoop({ model: scripted, prompt: "a" }),
          runLoop({ model: scripted, prompt: "b" }),
        ]);
      },
    );
    const { type, ran } = await drive(fn, false);

    expect(type).toBe("function-resolved");
    expect([...ran].sort()).toEqual(["agent-2:model:1", "agent:model:1"]);
  });

  test("adds up cache tokens when a model reports them", async () => {
    const withCache = (read: number, write: number) => {
      return {
        ...say("x"),
        usage: {
          input: 100,
          output: 5,
          cacheRead: read,
          cacheWrite: write,
        },
      };
    };
    const { steps, result } = await run([
      { ...call("add", { a: 1, b: 2 }), usage: withCache(0, 90).usage },
      withCache(90, 10),
    ]);

    expect(result?.usage).toMatchObject({
      input: 200,
      cacheRead: 90,
      cacheWrite: 100,
    });
    expect(scoresOf(stepNamed(steps, "agent:model:2"))).toMatchObject({
      "agent.cache_read_tokens": 90,
      "agent.cache_write_tokens": 10,
    });
  });
});

describe("prompt cache prefix with anthropic()", () => {
  const stripCache = (value: unknown): unknown => {
    return JSON.parse(
      JSON.stringify(value, (key, inner) => {
        return key === "cache_control" ? undefined : inner;
      }),
    );
  };

  test("every request starts with the messages of the one before, unedited", async () => {
    const bodies: { messages: unknown[] }[] = [];
    const replies = [1, 2, 3].map((n) => {
      return {
        content: [{ type: "tool_use", id: `t${n}`, name: "big", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });
    const client = {
      messages: {
        create: async (body: { messages: unknown[] }) => {
          bodies.push(structuredClone(body));

          return (replies[bodies.length - 1] ?? {
            content: [{ type: "text", text: "ok", citations: null }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          }) as never;
        },
      },
    };
    const big = tool.step({
      input: z.object({}),
      run: () => {
        return "z".repeat(150_000);
      },
    });

    await run([], {
      model: anthropic({ model: "claude-sonnet-5-5", client }),
      tools: { big },
    });

    expect(bodies).toHaveLength(4);

    for (let index = 1; index < bodies.length; index += 1) {
      const before = stripCache(bodies[index - 1]?.messages) as unknown[];

      expect(
        (stripCache(bodies[index]?.messages) as unknown[]).slice(
          0,
          before.length,
        ),
      ).toEqual(before);
    }
  });
});

describe("per-call options", () => {
  const ping = tool.step({
    description: "Pings",
    input: z.object({}),
    run: () => {
      return "pong";
    },
  });

  test("loop(batch, { tools }) adds tools to the model's request", async () => {
    const requests: AgentModelRequest[] = [];
    const client = new Inngest({ id: testClientId });
    const fn = client.createFunction(
      { id: "agent", triggers: [{ event: "agent/run" }] },
      async () => {
        const loop = agent.loop({
          model: model(async (request) => {
            requests.push(structuredClone(request));

            return say("ok");
          }),
          tools: { add },
        });

        await loop("go", { tools: { ping } });
      },
    );

    await drive(fn, false);

    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "add",
      "ping",
    ]);
  });

  test("the same tool name twice is an error", async () => {
    const loop = agent.loop({
      model: model(async () => {
        return say("ok");
      }),
      tools: { add },
    });

    await expect(loop("go", { tools: { add } })).rejects.toThrow(/"add"/);
  });

  test("maxTurns per call ends the loop after that many turns, and the default is 40", async () => {
    expect(defaultMaxTurns).toBe(40);

    const client = new Inngest({ id: testClientId });
    let limited: AgentLoopResult | undefined;
    const fn = client.createFunction(
      { id: "agent", triggers: [{ event: "agent/run" }] },
      async () => {
        limited = await agent.loop({
          model: model(async () => {
            return call("add", { a: 1, b: 2 });
          }),
          tools: { add },
        })("go", { maxTurns: 2 });
      },
    );

    await drive(fn, false);

    expect(limited).toMatchObject({ end: "maxTurns", turns: 2 });
  });

  test("end: stop is reached only through the stop option, checked before each model call", async () => {
    const asked: number[] = [];
    const { result, requests } = await run(
      [call("add", { a: 1, b: 2 }), say("never")],
      {
        stop: ({ turn }) => {
          asked.push(turn);

          return turn === 2;
        },
      },
    );

    expect(result?.end).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(asked).toContain(2);

    const { result: plain } = await run([say("done")]);

    expect(plain?.end).toBe("done");
  });
});

describe("onTurn", () => {
  test("a gated onTurn does not block the loop, and the last one finishes before the loop returns", async () => {
    // The first onTurn is released only once the second model request has
    // arrived. If onTurn blocked the loop, that request would never come.
    let secondRequest = false;
    const events: string[] = [];
    const { result, requests } = await run(
      [call("add", { a: 1, b: 2 }), say("ok")],
      {
        onRequest: (request) => {
          if (request.turn === 2) {
            secondRequest = true;
          }
        },
        onTurn: async ({ turn }) => {
          if (turn === 1) {
            const started = Date.now();

            while (!secondRequest && Date.now() - started < 1000) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }

            events.push(secondRequest ? "released" : "blocked");
          }

          events.push(`turn ${turn}`);
        },
      },
    );

    expect(requests).toHaveLength(2);
    expect(events).not.toContain("blocked");
    expect(events).toEqual(
      expect.arrayContaining(["released", "turn 1", "turn 2"]),
    );
    expect(result?.end).toBe("done");
  });

  test("a throwing onTurn does not fail the run, even the last one", async () => {
    const { result, type } = await run(
      [call("add", { a: 1, b: 2 }), say("ok")],
      {
        onTurn: () => {
          throw new Error("slow post failed");
        },
      },
    );

    expect(type).toBe("function-resolved");
    expect(result?.end).toBe("done");
  });
});

describe("cost", () => {
  test("a model that reports its own cost needs no price", async () => {
    const { result } = await run([{ ...say("done"), usd: 0.5 }]);

    expect(result?.usage.usd).toBe(0.5);
  });

  test("a price overrides the model's own cost", async () => {
    const { result } = await run([{ ...say("done"), usd: 0.5 }], {
      price: () => 2,
    });

    expect(result?.usage.usd).toBe(2);
  });
});

describe("formatEvent", () => {
  const from = { kind: "agent", address: "app/coder", key: "t7" };

  test("words a message from an agent, and one from a function", () => {
    expect(
      formatEvent({ name: "agent/message", data: { content: "hi", from } }),
    ).toBe("Message from app/coder (thread t7): hi");
    expect(
      formatEvent({
        name: "agent/message",
        data: {
          content: "hi",
          from: { kind: "function", id: "cron", key: "k" },
        },
      }),
    ).toBe("Message from function cron (thread k): hi");
  });

  test("a message with no sender says it is from outside the agent team, in a thread another agent started", async () => {
    await getAsyncLocalStorage();

    const inThread = (thread: string) => {
      return runWithAsyncCtx(
        {
          app: {} as never,
          execution: { agent: { thread, ref: "app/optimizer" } } as never,
        },
        () => {
          return formatEvent({
            name: "agent/message",
            data: { content: "try the cache first" },
          });
        },
      );
    };

    // A key a start made: the child's address, then the run, a count, the
    // tag and the starter.
    expect(inThread("app/optimizer:run1.0.0123456789abcdef.app%2Flead")).toBe(
      "Message from outside the agent team (not from an agent): try the cache first",
    );

    // A thread nobody started, such as a person's chat: the text alone.
    expect(inThread("chat-42")).toBe("try the cache first");

    // Outside a run: the text alone.
    expect(
      formatEvent({ name: "agent/message", data: { content: "hi" } }),
    ).toBe("hi");
  });

  test("words a question with its id, who asked and a pointer to the reply tool", () => {
    const text = formatEvent({
      name: "agent/question",
      data: { id: "q1", text: "Which branch?", from },
    });

    expect(text).toContain("q1");
    expect(text).toContain("app/coder");
    expect(text).toContain("Which branch?");
    expect(text).toContain("reply tool");
  });

  test("words a finished message with the outcome and the output or the error", () => {
    expect(
      formatEvent({
        name: "agent/finished",
        data: { outcome: "completed", output: "42", from },
      }),
    ).toBe("app/coder (thread t7) finished: completed. Output: 42");
    expect(
      formatEvent({
        name: "agent/finished",
        data: { outcome: "failed", error: "boom", from },
      }),
    ).toContain("failed. Error: boom");
    expect(
      formatEvent({
        name: "agent/finished",
        data: { outcome: "stopped", from },
      }),
    ).toContain("stopped");
  });

  test("shows an answer next to its question, and refusals and time-outs as plain lines", () => {
    const questions = new Map([["q1", "Which branch?"]]);

    expect(
      formatEvent(
        {
          name: "agent/answer",
          data: { re: "q1", outcome: "answered", text: "main", from },
        },
        questions,
      ),
    ).toBe('Answer to "Which branch?" from app/coder: main');
    expect(
      formatEvent(
        { name: "agent/answer", data: { re: "q1", outcome: "refused", from } },
        questions,
      ),
    ).toBe('No answer to "Which branch?": app/coder refused.');
    expect(
      formatEvent({
        name: "agent/answer",
        data: { re: "q2", outcome: "timed_out", from },
      }),
    ).toContain("did not answer in time");
  });

  test("falls back to JSON for any other event", () => {
    expect(formatEvent({ name: "ci/status", data: { state: "red" } })).toBe(
      JSON.stringify({ event: "ci/status", data: { state: "red" } }),
    );
  });
});

describe("compaction threshold", () => {
  test("starts at 70% of the model's context window unless a compaction is given", () => {
    expect(compactionFor(undefined, 200_000)).toEqual({ maxTokens: 140_000 });
    expect(compactionFor({ maxTokens: 5 }, 200_000)).toEqual({ maxTokens: 5 });
    expect(compactionFor(undefined, undefined)).toBeUndefined();
  });
});

describe("questions that already have a reply", () => {
  test("are not shown to the model", async () => {
    const asked: AgentEvent[] = [
      { id: "e1", name: "agent/question", data: { id: "q1", text: "old" } },
      { id: "e2", name: "agent/question", data: { id: "q2", text: "new" } },
    ];
    const { requests } = await run([say("ok")], {
      wiring: {
        drain: async () => {
          return asked;
        },
        answered: (id) => {
          return id === "q1";
        },
      },
    });
    const sent = JSON.stringify(requests[0]?.messages);

    expect(sent).toContain("new");
    expect(sent).not.toContain("old");
  });
});
