/**
 * @module
 * Type tests for agents used as tools: the input is `{ message }` or the
 * agent's invoke schema, and the output is what the agent returns.
 */
import { z } from "zod/v4";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { invoke } from "../triggers/triggers.ts";
import { createAgents } from "./agents.ts";
import { memoryKvAdapter } from "./kv.ts";
import { type AgentToolRun, agent } from "./loop.ts";

const agents = createAgents(new Inngest({ id: testClientId }), {
  store: memoryKvAdapter(),
});

const plain = agents.agent({ id: "plain" }, async () => {
  return { answer: "x" };
});

const typed = agents.agent(
  { id: "typed", on: invoke(z.object({ task: z.string() })) },
  async () => {
    return { summary: 1 };
  },
);

type Run = AgentToolRun<{ plain: typeof plain; typed: typeof typed }>;
type Named<TName extends string> = Extract<
  Run,
  { name: TName; isError: false }
>;

describe("agent tool types", () => {
  test("a plain agent takes a message and returns its result", () => {
    expectTypeOf<Named<"plain">["call"]["input"]>().toEqualTypeOf<{
      message: string;
    }>();
    expectTypeOf<Named<"plain">["output"]>().toEqualTypeOf<{
      answer: string;
    }>();
  });

  test("a typed agent takes its invoke data and returns its result", () => {
    expectTypeOf<Named<"typed">["call"]["input"]>().toEqualTypeOf<{
      task: string;
    }>();
    expectTypeOf<Named<"typed">["output"]>().toEqualTypeOf<{
      summary: number;
    }>();
  });

  test("agents go in the tools of a loop", () => {
    const run = () => {
      return agent.loop({
        model: async () => {
          throw new Error("unused");
        },
        prompt: "",
        tools: { plain, typed },
        onToolResult: (toolRun) => {
          if (toolRun.name === "typed" && !toolRun.isError) {
            expectTypeOf(toolRun.output).toEqualTypeOf<{ summary: number }>();
          }
        },
      });
    };

    expect(run).toBeTypeOf("function");
  });
});
