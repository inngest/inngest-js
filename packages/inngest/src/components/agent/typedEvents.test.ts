/**
 * @module
 * Type tests: the events of an agent's `on` type the handler's `event`, the
 * inbox messages and the sandbox config, and `agent.invoke()` takes the input
 * of the target's `invoke()` trigger.
 */
import { z } from "zod";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { eventType, invoke } from "../triggers/triggers.ts";
import { createAgents } from "./agents.ts";
import { agent } from "./loop.ts";

const order = eventType("shop/order.created", {
  schema: z.object({ id: z.string(), total: z.number() }),
});
const refund = eventType("shop/refund.created", {
  schema: z.object({ order: z.string(), amount: z.number() }),
});
const asked = invoke(z.object({ question: z.string() }));

const agents = createAgents(new Inngest({ id: testClientId }));

type Order = {
  id?: string;
  name: "shop/order.created";
  data: { id: string; total: number };
};

describe("typed events", () => {
  test("a single event type types the inbox and the handler event", () => {
    agents.agent(
      { id: "a1", on: { event: order, thread: "event.data.id" } },
      async ({ event, inbox }) => {
        expectTypeOf(event.data.event).toEqualTypeOf<Order | undefined>();

        const message = await inbox.next();

        expectTypeOf(message?.data.event).toEqualTypeOf<Order | undefined>();
        expectTypeOf(message?.data.content).toEqualTypeOf<string | undefined>();

        return undefined;
      },
    );
  });

  test("a list is the union of its events, a cron is a tick", () => {
    agents.agent(
      {
        id: "a2",
        on: [
          { event: order, thread: "event.data.id" },
          { event: refund, thread: "event.data.order" },
          { cron: "0 * * * *", thread: '"x"' },
        ],
      },
      async ({ inbox }) => {
        const message = await inbox.next();
        const trigger = message?.data.event;

        if (trigger?.name === "shop/order.created") {
          expectTypeOf(trigger.data.total).toBeNumber();
        }

        if (trigger?.name === "shop/refund.created") {
          expectTypeOf(trigger.data.amount).toBeNumber();
        }

        if (trigger?.name === "inngest/scheduled.timer") {
          expectTypeOf(trigger.data.cron).toBeString();
        }

        return undefined;
      },
    );
  });

  test("a name is any record, a cron alone is a tick", () => {
    agents.agent(
      { id: "a3", on: { event: "slack/message", thread: "event.data.ts" } },
      async ({ inbox }) => {
        const message = await inbox.next();

        expectTypeOf(message?.data.event?.name).toEqualTypeOf<
          "slack/message" | undefined
        >();
        expectTypeOf(message?.data.event?.data.anything).toBeAny();

        return undefined;
      },
    );

    agents.agent({ id: "a4", on: { cron: "* * * * *" } }, async ({ inbox }) => {
      const message = await inbox.next();

      expectTypeOf(message?.data.event?.data).toEqualTypeOf<
        { cron: string } | undefined
      >();

      return undefined;
    });
  });

  test("the sandbox config function sees the typed event", () => {
    agents.agent(
      {
        id: "a5",
        on: { event: order, thread: "event.data.id" },
        sandboxes: ({ event }) => {
          expectTypeOf(event.data.event).toEqualTypeOf<Order | undefined>();

          return {};
        },
      },
      async () => {
        return undefined;
      },
    );
  });
});

describe("agent.invoke", () => {
  const worker = agents.agent(
    { id: "worker", on: asked },
    async ({ event }) => {
      return { answer: event.data.event?.data.question ?? "" };
    },
  );
  const plain = agents.agent(
    { id: "plain", on: { event: "x/y", thread: "event.data.id" } },
    async () => {
      return 1;
    },
  );

  // Never called: the test is the types.
  const types = async () => {
    const result = await agent.invoke(worker, { question: "why" });

    expectTypeOf(result).toEqualTypeOf<{ answer: string }>();

    // @ts-expect-error the invoke trigger's input has a question
    await agent.invoke(worker, { nope: 1 });

    // An agent with no invoke trigger takes any record.
    expectTypeOf(await agent.invoke(plain, { any: 1 })).toBeNumber();

    // A string target stays untyped.
    expectTypeOf(await agent.invoke("app/other", { a: 1 })).toBeUnknown();
  };

  test("the target's invoke trigger types the input and its body the output", () => {
    expect(types).toBeTypeOf("function");
  });
});
