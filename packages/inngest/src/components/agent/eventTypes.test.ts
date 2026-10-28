/**
 * @module
 * Tests that the agent layer works with core's `eventType()`: the triggers
 * of an agent take every shape a function's triggers take and type the
 * events from them, the agent's own events are event types, and a cron
 * starts a thread of its own.
 */
import { z } from "zod";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { step } from "../InngestStepTools.ts";
import { eventType, invoke } from "../triggers/triggers.ts";
import { createAgents } from "./agents.ts";
import { agentMessage } from "./events.ts";
import { skillsBake } from "./skills.ts";
import { agentMessageEvent, type ThreadMessage } from "./thread.ts";
import { compileTriggers, singletonKey } from "./threadTrigger.ts";

const order = eventType("shop/order.created", {
  schema: z.object({ id: z.string(), total: z.number() }),
});
const refund = eventType("shop/refund.created", {
  schema: z.object({ order: z.string(), amount: z.number() }),
});
const ping = eventType("shop/ping");
const asked = invoke(z.object({ question: z.string() }));

const client = new Inngest({ id: testClientId });
const agents = createAgents(client);

const noop = async () => {};

const fnOptions = (fn: { opts?: unknown }) => {
  return (fn as unknown as { ["opts"]: unknown })["opts"] as {
    triggers: unknown[];
    singleton: { key: string };
    cancelOn: { event: string; if: string }[];
  };
};

describe("types", () => {
  test("on takes an event name, an event type, a bare event type and a cron", () => {
    agents.agent(
      { id: "t1", on: { event: "shop/x", thread: "event.data.id" } },
      noop,
    );
    agents.agent(
      { id: "t2", on: { event: order, thread: "event.data.id" } },
      noop,
    );
    agents.agent({ id: "t3", on: order, thread: "event.data.id" }, noop);
    agents.agent({ id: "t4", on: { cron: "0 * * * *" } }, noop);
    agents.agent(
      {
        id: "t5",
        on: [
          { event: order, if: "event.data.total > 5", thread: "event.data.id" },
          ping,
          { cron: "0 * * * *", thread: '"nightly"' },
        ],
        thread: "event.data.id",
      },
      noop,
    );
  });

  test("message is typed from the trigger's event type", () => {
    agents.agent(
      {
        id: "t6",
        on: [
          {
            event: order,
            thread: "event.data.id",
            message: (event) => {
              expectTypeOf(event.data).toEqualTypeOf<{
                id: string;
                total: number;
              }>();

              return String(event.data.total);
            },
          },
          {
            event: refund,
            thread: "event.data.order",
            message: (event) => {
              expectTypeOf(event.data).toEqualTypeOf<{
                order: string;
                amount: number;
              }>();

              return String(event.data.amount);
            },
          },
          {
            event: "plain/name",
            thread: "event.data.id",
            message: (event) => {
              return String(event.data.anything);
            },
          },
          {
            cron: "0 * * * *",
            message: (event) => {
              expectTypeOf(event.data).toEqualTypeOf<{ cron: string }>();

              return event.data.cron;
            },
          },
        ],
      },
      noop,
    );

    agents.agent(
      {
        id: "t7",
        on: {
          event: order,
          thread: "event.data.id",
          message: (event) => {
            expectTypeOf(event.data.total).toBeNumber();

            return undefined;
          },
        },
      },
      noop,
    );
  });

  test("a wrong field or a non-trigger is a type error", () => {
    agents.agent(
      {
        id: "t8",
        on: {
          event: order,
          thread: "event.data.id",
          message: (event) => {
            // @ts-expect-error order has no amount
            return String(event.data.amount);
          },
        },
      },
      noop,
    );

    expect(() => {
      // @ts-expect-error a name alone is not a trigger
      return agents.agent({ id: "t9", on: ["shop/x"] }, noop);
    }).toThrow(/takes triggers/);
  });

  test("the agent's events are event types with typed data", () => {
    expectTypeOf(agentMessage.name).toEqualTypeOf<"agent/message">();
    expectTypeOf(agentMessageEvent).toEqualTypeOf<"agent/message">();
    expectTypeOf(agentMessage.create)
      .parameter(0)
      .toEqualTypeOf<ThreadMessage>();
    expectTypeOf(skillsBake.name).toEqualTypeOf<"agent/skills.bake">();

    // @ts-expect-error a message needs its thread
    agentMessage.create({ agent: "app/bot", kind: "user" });
  });
});

describe("step.subscribe", () => {
  // Never called: the test is the types.
  const types = async () => {
    const one = await step.subscribe("one", { event: order });
    const message = await one.next();

    expectTypeOf(message?.data).toEqualTypeOf<
      { id: string; total: number } | undefined
    >();

    const many = await step.subscribe("many", {
      events: [
        { event: order },
        { event: refund, if: "async.data.amount > 1" },
      ],
    });
    const either = await many.next();

    expectTypeOf(either?.data).toEqualTypeOf<
      | { id: string; total: number }
      | { order: string; amount: number }
      | undefined
    >();

    const named = await step.subscribe("named", { event: "shop/x" });

    expectTypeOf((await named.next())?.data).toBeUnknown();

    const given = await step.subscribe<{ n: number }>("given", {
      event: "shop/x",
    });

    expectTypeOf((await given.next())?.data).toEqualTypeOf<
      { n: number } | undefined
    >();

    // @ts-expect-error an event type's data has no such field
    (await one.next())?.data.amount;
  };

  test("takes event types and infers the message data", () => {
    expect(types).toBeTypeOf("function");
  });
});

describe("events", () => {
  test("the agent's events keep their names", () => {
    expect(agentMessage.name).toBe("agent/message");
    expect(skillsBake.name).toBe("agent/skills.bake");
  });

  test("a created message carries the schema it is validated against", async () => {
    const message = agentMessage.create({
      agent: "app/bot",
      thread: "t1",
      kind: "user",
    });

    await expect(message.validate()).resolves.toBeUndefined();
    expect(message.name).toBe("agent/message");
  });
});

describe("triggers", () => {
  test("an event type reaches the function as itself, so core validates it", () => {
    const agent = agents.agent(
      {
        id: "u1",
        on: [
          { event: order, if: "event.data.total > 5", thread: "event.data.id" },
          ping,
        ],
        thread: "event.data.id",
      },
      noop,
    );
    const options = fnOptions(agent.fn);

    expect(options.triggers).toEqual([
      expect.objectContaining({ event: "agent/message" }),
      { event: order, if: "event.data.total > 5" },
      { event: ping },
    ]);
  });

  test("a cron starts one thread per agent by default", () => {
    const compiled = compileTriggers("nightly", {
      on: { cron: "0 3 * * *" },
    });

    expect(compiled).toHaveLength(1);
    expect(compiled[0]?.event).toBe("inngest/scheduled.timer");
    expect(compiled[0]?.cron).toBe(true);
    expect(
      compiled[0]?.thread.key({
        name: "inngest/scheduled.timer",
        data: { cron: "0 3 * * *" },
      }),
    ).toBe("nightly");
    expect(compiled[0]?.fnTrigger).toEqual({ cron: "0 3 * * *" });
  });

  test("a cron's thread can be set on the cron, and the agent's thread is for events", () => {
    const compiled = compileTriggers("bot", {
      thread: "event.data.id",
      on: [
        { event: "shop/x" },
        { cron: "0 3 * * *", thread: "event.data.cron" },
      ],
    });

    expect(compiled[0]?.thread.source).toBe("event.data.id");
    expect(compiled[1]?.thread.source).toBe("event.data.cron");
  });

  test("crons share one thread key", () => {
    expect(() => {
      return compileTriggers("bot", {
        on: [
          { cron: "0 3 * * *", thread: '"a"' },
          { cron: "0 4 * * *", thread: '"b"' },
        ],
      });
    }).toThrow(/share one thread key/);

    expect(
      compileTriggers("bot", {
        on: [{ cron: "0 3 * * *" }, { cron: "0 4 * * *" }],
      }),
    ).toHaveLength(2);
  });

  test("the singleton is keyed on the cron's thread", () => {
    const agent = agents.agent({ id: "u2", on: { cron: "0 3 * * *" } }, noop);
    const options = fnOptions(agent.fn);

    expect(options.triggers[1]).toEqual({ cron: "0 3 * * *" });
    expect(options.singleton.key).toBe(
      'event.name == "inngest/scheduled.timer" ? ("u2") : event.data.thread',
    );
    expect(
      singletonKey(compileTriggers("u2", { on: { cron: "0 3 * * *" } })),
    ).toBe(options.singleton.key);
  });

  test("an invoke trigger makes the agent invokable, one thread per agent", () => {
    const compiled = compileTriggers("worker", {
      on: invoke(z.object({ question: z.string() })),
    });

    expect(compiled[0]?.listen).toBe(false);
    expect(compiled[0]?.thread.source).toBe(
      'has(event.data.thread) ? event.data.thread : ("worker")',
    );
    expect(
      compiled[0]?.thread.key({
        name: "inngest/function.invoked",
        data: { thread: "t9" },
      }),
    ).toBe("t9");
    expect(
      compiled[0]?.thread.key({ name: "inngest/function.invoked", data: {} }),
    ).toBe("worker");

    agents.agent(
      {
        id: "u3",
        on: [
          {
            event: asked,
            message: (event) => {
              expectTypeOf(event.data).toEqualTypeOf<{ question: string }>();

              return event.data.question;
            },
          },
        ],
      },
      noop,
    );
  });

  test("the agent's own events and mixed triggers are refused", () => {
    expect(() => {
      return compileTriggers("bot", { on: agentMessage });
    }).toThrow(/other than/);
    expect(() => {
      return compileTriggers("bot", { on: skillsBake });
    }).toThrow(/other than/);
    expect(() => {
      return compileTriggers("bot", {
        on: { event: "inngest/scheduled.timer", thread: '"a"' },
      });
    }).toThrow(/other than/);
    expect(() => {
      return compileTriggers("bot", {
        on: { cron: "* * * * *", event: "shop/x" } as never,
      });
    }).toThrow(/not both/);
  });

  test("only the first of several crons sets session and message", () => {
    expect(() => {
      return compileTriggers("bot", {
        on: [{ cron: "0 3 * * *" }, { cron: "0 4 * * *", message: () => "x" }],
      });
    }).toThrow(/first cron/);
  });

  test("an event type's name is checked like a name", () => {
    expect(() => {
      return compileTriggers("bot", { on: agentMessage });
    }).toThrow(/other than "agent\/message"/);
  });
});
