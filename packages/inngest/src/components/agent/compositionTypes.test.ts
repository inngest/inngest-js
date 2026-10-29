/**
 * @module
 * Composition type tests: the agent pieces used together infer end to end
 * with no annotations. An agent triggered by an event type invokes a typed
 * agent, subscribes to typed events, reports to a channel and runs a sandbox
 * tool. The assertions are types; the bodies of agents are never executed.
 */
import { z } from "zod";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { step } from "../InngestStepTools.ts";
import { tool } from "../sandbox/tools.ts";
import { eventType, invoke } from "../triggers/triggers.ts";
import { createAgents } from "./agents.ts";
import { defineChannel } from "./channels.ts";
import { sandbox } from "./defs.ts";
import { agent } from "./loop.ts";

const order = eventType("shop/order.created", {
  schema: z.object({ id: z.string(), total: z.number() }),
});
const refund = eventType("shop/refund.created", {
  schema: z.object({ order: z.string(), amount: z.number() }),
});
const asked = invoke(z.object({ question: z.string() }));

const agents = createAgents(new Inngest({ id: testClientId }));

const researcher = agents.agent(
  { id: "researcher", on: asked },
  async ({ event }) => {
    return { answer: event.data.event?.data.question ?? "" };
  },
);

const notes: string[] = [];
const notesChannel = defineChannel({
  post: async (message) => {
    notes.push(message.text);
  },
});

const workbench = sandbox({
  id: "workbench",
  tools: sandbox.tools.code(),
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
  test("an agent on an event type uses typed agents, subscriptions, channels and sandboxes", () => {
    agents.agent(
      {
        id: "lead",
        on: { event: order, thread: "event.data.id" },
        channels: { main: notesChannel },
        sandboxes: { work: workbench },
      },
      async ({ event, inbox, report, sandboxTools }) => {
        expectTypeOf(event.data.event?.data.total).toEqualTypeOf<
          number | undefined
        >();

        const found = await agent.invoke(researcher, { question: "why" });

        expectTypeOf(found).toEqualTypeOf<{ answer: string }>();

        const refunds = await step.subscribe("refunds", { event: refund });
        const refunded = await refunds.next();

        expectTypeOf(refunded?.data.data.amount).toEqualTypeOf<
          number | undefined
        >();

        const mixed = await step.subscribe("mixed", {
          events: [{ event: order }, { event: refund }],
        });
        const either = await mixed.next();

        expectTypeOf(either?.data.data).toEqualTypeOf<
          | { id: string; total: number }
          | { order: string; amount: number }
          | undefined
        >();

        const named = await step.subscribe("named", { event: "x/y" });

        expectTypeOf((await named.next())?.data).toBeUnknown();

        await report("found it");
        await report({ text: "done", kind: "result" });

        const next = await inbox.next();

        expectTypeOf(next?.data.event?.name).toEqualTypeOf<
          "shop/order.created" | undefined
        >();

        return agent.loop({
          model: async () => {
            return {
              message: { role: "assistant", content: "ok" },
              toolCalls: [],
            };
          },
          prompt: "go",
          tools: { ...sandboxTools, lookup },
        });
      },
    );
  });

  test("an agent's result type is what its body returns", () => {
    const lead = agents.agent(
      { id: "lead2", on: order, thread: "event.data.id" },
      async () => {
        return { ok: true as const };
      },
    );

    expectTypeOf<
      NonNullable<(typeof lead)["~types"]>["output"]
    >().toEqualTypeOf<{ ok: true }>();
  });

  test("an explicit subscription type is for named events, and any stays any", () => {
    const check = async () => {
      const explicit = await step.subscribe<{ q: 1 }>("e", {
        event: "shop/order.created",
      });

      expectTypeOf((await explicit.next())?.data).toEqualTypeOf<
        { q: 1 } | undefined
      >();

      // biome-ignore lint/suspicious/noExplicitAny: the test is that any stays any
      const loose = await step.subscribe<any>("l", { event: "shop/x" });

      expectTypeOf((await loose.next())?.data).toBeAny();

      // @ts-expect-error an event type gives the message data, so it is not overridden
      await step.subscribe<{ q: 1 }>("o", { event: order });
    };

    expect(check).toBeTypeOf("function");
  });
});

describe("pointed errors", () => {
  test("a sandbox tool's run and output follow its schemas", () => {
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
  });

  test("a channel needs post, and a loop tool must be a tool", () => {
    const check = () => {
      // @ts-expect-error a channel without post
      defineChannel({});

      agent.loop({
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

  test("invoking an agent checks the input against its invoke trigger", () => {
    const check = async () => {
      // @ts-expect-error question is a string
      await agent.invoke(researcher, { question: 5 });

      // @ts-expect-error nope is not a field of the input
      await agent.invoke(researcher, { nope: "x" });
    };

    expect(check).toBeTypeOf("function");
  });
});
