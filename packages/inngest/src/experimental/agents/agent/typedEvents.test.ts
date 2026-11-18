/**
 * @module
 * Type tests: the events of an agent's `on` type the handler's `event`, the
 * inbox messages and the sandbox config.
 */
import { z } from "zod";
import { Inngest } from "../../../components/Inngest.ts";
import { eventType, invoke } from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import { createAgents } from "./agents.ts";

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
      { id: "a1", triggers: { event: order, thread: "event.data.id" } },
      async ({ event, inbox }) => {
        expectTypeOf(event.data).toEqualTypeOf<Order["data"]>();

        const message = await inbox.next();

        // The message is the trigger event, flat; a plain thread message is
        // `agent/message`.
        expectTypeOf(message?.name).toEqualTypeOf<
          | "shop/order.created"
          | "agent/message"
          | "agent/question"
          | "agent/answer"
          | "agent/finished"
          | undefined
        >();

        if (message?.name === "shop/order.created") {
          expectTypeOf(message.data).toEqualTypeOf<Order["data"]>();
        }

        switch (message?.name) {
          case "shop/order.created":
            expectTypeOf(message.data.total).toBeNumber();
            break;
          case "agent/message":
            expectTypeOf(message.data.thread).toBeString();
            break;
          default:
            break;
        }

        return undefined;
      },
    );
  });

  test("a list is the union of its events, a cron is a tick", () => {
    agents.agent(
      {
        id: "a2",
        triggers: [
          { event: order, thread: "event.data.id" },
          { event: refund, thread: "event.data.order" },
          { cron: "0 * * * *", thread: '"x"' },
        ],
      },
      async ({ inbox }) => {
        const message = await inbox.next();
        const trigger = message;

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

  test("a list of bare event types types the inbox", () => {
    agents.agent(
      {
        id: "a-bare",
        triggers: [order, refund, asked],
        thread: "event.data.id",
      },
      async ({ inbox }) => {
        const message = await inbox.next();
        const trigger = message;

        if (trigger?.name === "shop/order.created") {
          expectTypeOf(trigger.data.total).toBeNumber();
        }

        if (trigger?.name === "shop/refund.created") {
          expectTypeOf(trigger.data.amount).toBeNumber();
        }

        return undefined;
      },
    );
  });

  test("event is the event of triggers, flat and typed, narrowed by name", () => {
    agents.agent(
      { id: "t1", triggers: { event: order, thread: "event.data.id" } },
      async ({ event }) => {
        expectTypeOf(event.name).toEqualTypeOf<"shop/order.created">();
        expectTypeOf(event.data.total).toBeNumber();

        return undefined;
      },
    );

    agents.agent(
      {
        id: "t2",
        triggers: [
          { event: order, thread: "event.data.id" },
          { event: refund, thread: "event.data.order" },
          { cron: "0 * * * *", thread: '"x"' },
        ],
      },
      async ({ event }) => {
        if (event.name === "shop/order.created") {
          expectTypeOf(event.data.total).toBeNumber();
        }

        if (event.name === "shop/refund.created") {
          expectTypeOf(event.data.amount).toBeNumber();
        }

        if (event.name === "inngest/scheduled.timer") {
          expectTypeOf(event.data.cron).toBeString();
        }

        return undefined;
      },
    );

    agents.agent(
      {
        id: "t3",
        triggers: { event: "chat/message", thread: "event.data.ts" },
      },
      async ({ event }) => {
        expectTypeOf(event.name).toEqualTypeOf<"chat/message">();

        return undefined;
      },
    );
  });

  test("is() narrows the messages of on and of the sources", () => {
    agents.agent(
      {
        id: "a-src",
        triggers: { event: order, thread: "event.data.id" },
        inbox: [{ event: refund, thread: "event.data.order" }],
      },
      async ({ inbox }) => {
        const message = await inbox.next();

        if (message?.is(order)) {
          expectTypeOf(message.name).toEqualTypeOf<"shop/order.created">();
          expectTypeOf(message.data.total).toBeNumber();
        }

        // A source's message keeps its own event name; is() types it.
        const refunds = await inbox.next();

        if (refunds?.is(refund)) {
          expectTypeOf(refunds.data.amount).toBeNumber();
        }

        return undefined;
      },
    );
  });

  test("a name is any record, a cron alone is a tick", () => {
    agents.agent(
      {
        id: "a3",
        triggers: { event: "chat/message", thread: "event.data.ts" },
      },
      async ({ inbox }) => {
        const message = await inbox.next();

        expectTypeOf(message?.name).toEqualTypeOf<
          | "chat/message"
          | "agent/message"
          | "agent/question"
          | "agent/answer"
          | "agent/finished"
          | undefined
        >();

        if (message?.name === "chat/message") {
          expectTypeOf(message.data.anything).toBeAny();
        }

        return undefined;
      },
    );

    agents.agent(
      { id: "a4", triggers: { cron: "* * * * *" } },
      async ({ inbox }) => {
        const message = await inbox.next();

        expectTypeOf(message?.name).toEqualTypeOf<
          | "inngest/scheduled.timer"
          | "agent/message"
          | "agent/question"
          | "agent/answer"
          | "agent/finished"
          | undefined
        >();

        if (message?.name === "inngest/scheduled.timer") {
          expectTypeOf(message.data).toEqualTypeOf<{ cron: string }>();
        }

        return undefined;
      },
    );
  });

  test("the sandbox config function sees the typed event", () => {
    agents.agent(
      {
        id: "a5",
        triggers: { event: order, thread: "event.data.id" },
        sandboxes: ({ event }) => {
          expectTypeOf(event.data).toEqualTypeOf<Order["data"]>();

          return {};
        },
      },
      async () => {
        return undefined;
      },
    );
  });
});
