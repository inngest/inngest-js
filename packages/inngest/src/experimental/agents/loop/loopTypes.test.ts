/**
 * @module
 * Type tests for the loop: the shape of its result, its options, and the
 * names that are gone. The closures hold type-only code that never runs.
 */
import { expectTypeOf, test } from "vitest";
import { z } from "zod/v4";
import { tool } from "../../../components/sandbox/tools.ts";
import { createAgents } from "../agent/agents.ts";
import { agents, created, typesOnly } from "../agent/typeFixtures.ts";
import type { AgentFunctionConfig } from "../agent/types.ts";
import * as entry from "../index.ts";
import type {
  AgentEvent,
  AgentHandlerLoop,
  AgentLoop,
  AgentLoopEnd,
  AgentLoopResult,
  AgentModel,
  AgentToolRun,
  AgentTurn,
  AgentUsage,
  ModelMessage,
} from "./loop.ts";
import { agent, agentModel, formatEvent } from "./loop.ts";

const lookup = tool.step({
  description: "Looks a ticket up",
  input: z.object({ id: z.number() }),
  output: z.object({ title: z.string() }),
  run: () => {
    return { title: "x" };
  },
});

const model = agentModel(async () => {
  return { message: { role: "assistant", content: [] }, toolCalls: [] };
}) satisfies AgentModel;

test("loop: the result has text, end, turns, usage, history, toolCalls and unread", () => {
  const check = async () => {
    const result = await agent.loop({ model, tools: { lookup } })("go");

    expectTypeOf(result.text).toEqualTypeOf<string>();
    expectTypeOf(result.end).toEqualTypeOf<AgentLoopEnd>();
    expectTypeOf(result.turns).toEqualTypeOf<number>();
    expectTypeOf(result.usage).toEqualTypeOf<AgentUsage>();
    expectTypeOf(result.history).toEqualTypeOf<ModelMessage[]>();
    expectTypeOf(result.unread).toEqualTypeOf<AgentEvent[]>();
    expectTypeOf(result.reason).toEqualTypeOf<string | undefined>();
  };

  expectTypeOf(check).toBeFunction();
});

test("loop: end is the five-value union", () => {
  expectTypeOf<AgentLoopEnd>().toEqualTypeOf<
    "done" | "maxTurns" | "stop" | "budget" | "noToolCall"
  >();
  expectTypeOf<AgentLoopResult["end"]>().toEqualTypeOf<AgentLoopEnd>();
});

test("loop: tool calls narrow input and output by the tool's name", () => {
  const check = async () => {
    const result = await agent.loop({ model, tools: { lookup } })("go");

    expectTypeOf(result.toolCalls).toEqualTypeOf<
      AgentToolRun<{ lookup: typeof lookup }>[]
    >();

    for (const run of result.toolCalls) {
      if (!run.isError) {
        expectTypeOf(run.name).toEqualTypeOf<"lookup">();
        expectTypeOf(run.output).toEqualTypeOf<{ title: string }>();
      }
    }
  };

  expectTypeOf(check).toBeFunction();
});

test("loop: loop(batch) takes tools, steer, onTurn, maxTurns, maxToolOutput and wrapUp per call (the name in type-tests.md, 'no per-call overrides', is stale)", () => {
  const check = async () => {
    const loop = agent.loop({ model });

    await loop("go", {
      tools: { lookup },
      steer: (drained) => {
        return drained;
      },
      onTurn: (turn) => {
        expectTypeOf(turn).toEqualTypeOf<AgentTurn>();
      },
      maxTurns: 2,
      maxToolOutput: 10,
      wrapUp: "Answer now.",
    });

    // @ts-expect-error an unknown option is still an error
    await loop("go", { temperature: 1 });
    // @ts-expect-error the model is not a per-call option
    await loop("go", { model });
  };

  expectTypeOf(check).toBeFunction();
});

test("loop: loop.with(options) in a handler needs no model", () => {
  const check = (loop: AgentHandlerLoop) => {
    void loop.with({ tools: { lookup } });
    void loop.with({ model });
    void loop.with({});
  };

  expectTypeOf(check).toBeFunction();
});

test("loop: the definition's loop takes options or a whole loop", () => {
  const options: AgentFunctionConfig["loop"] = { maxTurns: 10 };
  const whole: AgentFunctionConfig["loop"] = agent.loop({ model });

  expectTypeOf(options).not.toBeNever();
  expectTypeOf(whole).not.toBeNever();

  // @ts-expect-error an unknown option
  const bad: AgentFunctionConfig["loop"] = { maxTurn: 10 };

  void bad;
});

test("loop: agent.loop(options) outside an agent requires a model", () => {
  const check = () => {
    // @ts-expect-error a standalone loop has only its options
    agent.loop({});
    // @ts-expect-error a standalone loop has only its options
    agent.loop({ tools: { lookup } });
  };

  expectTypeOf(check).toBeFunction();
});

test("loop: onTurn gets the turn and cannot be required to return a value", () => {
  const check = () => {
    agent.loop({
      model,
      onTurn: (turn) => {
        expectTypeOf(turn.turn).toEqualTypeOf<number>();
        expectTypeOf(turn.stepId).toEqualTypeOf<string>();
        expectTypeOf(turn.text).toEqualTypeOf<string>();
        expectTypeOf(turn.usage).toEqualTypeOf<AgentUsage>();
        expectTypeOf(turn).not.toHaveProperty("recorded");
      },
    });
    agent.loop({ model, onTurn: async () => {} });
  };

  expectTypeOf(check).toBeFunction();
});

test("loop: the model field takes anthropic() or any function of the model shape", () => {
  const check = () => {
    agent.loop({
      model: async (request) => {
        expectTypeOf(request.turn).toEqualTypeOf<number>();

        return { message: { role: "assistant", content: [] }, toolCalls: [] };
      },
    });
    createAgents(null as never).agent({
      id: "a",
      triggers: [{ event: "x/y" }],
      model: entry.anthropic({ model: "claude-sonnet-5-5" }),
    });
  };

  expectTypeOf(check).toBeFunction();
});

test("loop: the assistant's reply content is deliberately unknown", () => {
  // The loop keeps a reply exactly as the model returned it, so provider parts
  // (thinking blocks and their signatures) round-trip: `unknown` is on purpose.
  expectTypeOf<
    Extract<ModelMessage, { role: "assistant" }>["content"]
  >().toEqualTypeOf<unknown>();
});

test("loop: the agent object has only loop and toolError", () => {
  expectTypeOf(agent).toHaveProperty("loop");
  expectTypeOf(agent).toHaveProperty("toolError");
  expectTypeOf(agent).not.toHaveProperty("untrusted");
  expectTypeOf(agent).not.toHaveProperty("model");
  expectTypeOf(agent).not.toHaveProperty("anthropic");
  expectTypeOf(agent).not.toHaveProperty("classifyModelError");
});

test("loop: stop is the way to reach the stop end", () => {
  const check = () => {
    agent.loop({
      model,
      stop: ({ turn }) => {
        expectTypeOf(turn).toEqualTypeOf<number>();

        return turn > 3;
      },
    });
    agent.loop({
      model,
      stop: async () => {
        return false;
      },
    });
  };

  expectTypeOf(check).toBeFunction();
});

test("loop: control, recordTurn, onToolResult, foldMessages and scores are errors", () => {
  const check = () => {
    // @ts-expect-error gone: the loop wires itself
    agent.loop({ model, control: {} });
    // @ts-expect-error gone: internal
    agent.loop({ model, recordTurn: async () => {} });
    // @ts-expect-error gone: wrap the tool instead
    agent.loop({ model, onToolResult: () => {} });
    // @ts-expect-error gone: the loop folds by default
    agent.loop({ model, foldMessages: "all" });
    // @ts-expect-error gone: scores are always on
    agent.loop({ model, scores: false });
  };

  expectTypeOf(check).toBeFunction();
});

test("loop: a custom fold takes the drained messages and returns the ones to fold", () => {
  const check = () => {
    agent.loop({
      model,
      steer: (drained) => {
        expectTypeOf(drained).toEqualTypeOf<AgentEvent[]>();

        return drained.filter((message) => {
          return message.name === "agent/message";
        });
      },
    });
    agent.loop({
      model,
      steer: async (drained) => {
        return drained;
      },
    });
  };

  expectTypeOf(check).toBeFunction();
});

test("loop: format and formatEvent take a message", () => {
  const check = () => {
    agent.loop({
      model,
      format: (message) => {
        return message.name === "ci/status" ? "red" : formatEvent(message);
      },
    });
  };

  expectTypeOf(formatEvent).parameter(0).toEqualTypeOf<AgentEvent>();
  expectTypeOf(formatEvent).returns.toBeString();
  expectTypeOf(check).toBeFunction();
});

test("loop: the loop's types are assignable to the plain ones", () => {
  const typed = agent.loop({ model, tools: { lookup } });
  const plain: AgentLoop = typed;

  expectTypeOf(plain).not.toBeNever();
});

test("agents: the model, system, tools, loop and remember fields take a value or a function", () => {
  const check = () => {
    const config: AgentFunctionConfig = {
      id: "a",
      model,
      system: ({ thread }) => `Thread ${thread.key}`,
      tools: async () => {
        return { lookup };
      },
      remember: false,
    };

    const second: AgentFunctionConfig = {
      id: "b",
      system: "plain",
      tools: { lookup },
      remember: () => true,
    };

    void config;
    void second;
  };

  expectTypeOf(check).toBeFunction();
});

test("loop: a budget end carries a reason and no other end does", () => {
  typesOnly(() => {
    agents.agent(
      { id: "loop-3", triggers: [created], model },
      async ({ inbox, loop }) => {
        const result = await loop(await inbox.drain());

        if (result.end === "budget") {
          expectTypeOf(result.reason).toBeString();
        } else {
          expectTypeOf(result.reason).toEqualTypeOf<undefined>();
        }

        return null;
      },
    );
  });
});
