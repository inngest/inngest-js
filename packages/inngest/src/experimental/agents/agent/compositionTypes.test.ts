/**
 * @module
 * Composition type tests: the agent pieces used together infer end to end
 * with no annotations. An agent triggered by an event type reads typed
 * events from its inbox and runs a sandbox tool. The assertions are types; the bodies of agents are never executed.
 * Each `check` closure holds type-only code that must not run (it would call
 * into a function context), so `expect(check).toBeTypeOf("function")` only
 * gives vitest a runtime assertion and keeps the closure used.
 */

import { z } from "zod";
import { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { tool } from "../../../components/sandbox/tools.ts";
import { eventType } from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import { agent } from "../loop/loop.ts";
import { model, runLoop } from "../loop/loopKit.ts";
import { sandbox } from "../sandboxes/defs.ts";
import { createAgents } from "./agents.ts";

const order = eventType("shop/order.created", {
  schema: z.object({ id: z.string(), total: z.number() }),
});

const agents = createAgents(new Inngest({ id: testClientId }));

const workbench = sandbox({
  id: "workbench",
  tools: sandbox.tools.defaults,
});

const lookup = tool.step({
  input: z.object({ id: z.string() }),
  output: z.object({ total: z.number() }),
  run: async ({ id }) => {
    expectTypeOf(id).toBeString();

    return { total: 1 };
  },
});

describe("composition", () => {
  test("an agent on an event type uses typed events, an inbox and sandboxes", () => {
    agents.agent(
      {
        id: "lead",
        triggers: { event: order, thread: "event.data.id" },
        sandboxes: { work: workbench },
      },
      async ({ event, inbox }) => {
        expectTypeOf(event.data.total).toEqualTypeOf<number>();

        const next = await inbox.next();

        expectTypeOf(next?.name).toEqualTypeOf<
          | "shop/order.created"
          | "agent/message"
          | "agent/question"
          | "agent/answer"
          | "agent/finished"
          | undefined
        >();

        return runLoop({
          model: async () => {
            return {
              message: { role: "assistant", content: "ok" },
              toolCalls: [],
            };
          },
          prompt: "go",
          tools: { lookup },
        });
      },
    );
  });

  test("an agent's result type is what its body returns", () => {
    const lead = agents.agent(
      { id: "lead2", triggers: order, thread: "event.data.id" },
      async () => {
        return { ok: true as const };
      },
    );

    expectTypeOf<
      NonNullable<(typeof lead)["~types"]>["output"]
    >().toEqualTypeOf<{ ok: true }>();
  });
});

describe("pointed errors", () => {
  test("a sandbox tool's run and output follow its schemas", () => {
    const check = () => {
      tool.step({
        input: z.object({ id: z.string() }),
        // @ts-expect-error the run takes the input schema's output, a string id
        run: async ({ id }: { id: number }) => {
          return id;
        },
      });

      tool.step({
        input: z.object({ id: z.string() }),
        output: z.object({ n: z.number() }),
        // @ts-expect-error the result must match the output schema
        run: async ({ id }) => {
          return { n: id };
        },
      });
    };

    expect(check).toBeTypeOf("function");
  });

  test("a loop tool must be a tool", () => {
    const check = () => {
      runLoop({
        model: async () => {
          return {
            message: { role: "assistant", content: "ok" },
            toolCalls: [],
          };
        },
        prompt: "go",
        // @ts-expect-error a number is not a tool
        tools: { a: 5 },
      });
    };

    expect(check).toBeTypeOf("function");
  });
});
