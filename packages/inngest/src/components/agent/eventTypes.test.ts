/**
 * @module
 * Tests that the agent layer works with core's `eventType()`: the triggers
 * of an agent take every shape a function's triggers take and type the
 * events from them, the agent's own events are event types, and a cron
 * starts a thread of its own.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { step } from "../InngestStepTools.ts";
import { eventType, invoke } from "../triggers/triggers.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import { agentMessage, agentSteer } from "./events.ts";
import { createKv, memoryKvAdapter } from "./kv.ts";
import { skillsBake } from "./skills.ts";
import { run } from "./test-helpers.ts";
import { agentMessageEvent, agentSteerEvent } from "./thread.ts";
import {
  compileTriggers,
  schemaProblem,
  singletonKey,
} from "./threadTrigger.ts";

const order = eventType("shop/order.created", {
  schema: z.object({ id: z.string(), total: z.number() }),
});
const refund = eventType("shop/refund.created", {
  schema: z.object({ order: z.string(), amount: z.number() }),
});
const ping = eventType("shop/ping");

const client = new Inngest({ id: testClientId });
const agents = createAgents(client);

const noop = async () => {};

const fnOptions = (fn: { opts?: unknown }) => {
  return (fn as unknown as { ["opts"]: unknown })["opts"] as {
    triggers: unknown[];
    singleton: { key: string };
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

  test("a wrong field or a non-trigger is a type error", () => {
    expect(() => {
      // @ts-expect-error a name alone is not a trigger
      return agents.agent({ id: "t9", on: ["shop/x"] }, noop);
    }).toThrow(/takes triggers/);
  });

  test("the agent's events are event types with typed data", () => {
    expectTypeOf(agentMessage.name).toEqualTypeOf<"agent/message">();
    expectTypeOf(agentMessageEvent).toEqualTypeOf<"agent/message">();
    expectTypeOf(agentSteer.name).toEqualTypeOf<"agent/steer">();
    expectTypeOf(agentSteerEvent).toEqualTypeOf<"agent/steer">();
    expectTypeOf(agentSteer.create)
      .parameter(0)
      .toExtend<{ agent: string; thread: string; text: string }>();

    expectTypeOf(skillsBake.name).toEqualTypeOf<"agent/skills.bake">();

    // @ts-expect-error a message needs its thread
    agentMessage.create({ agent: "app/bot", text: "hi" });
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

    // An explicit any stays any, for events named by a string.
    // biome-ignore lint/suspicious/noExplicitAny: the case under test
    const loose = await step.subscribe<any>("loose", { event: "shop/x" });

    expectTypeOf((await loose.next())?.data).toBeAny();

    // @ts-expect-error an event type already gives the message data: it is not overridden
    await step.subscribe<{ q: 1 }>("override", { event: order });

    // @ts-expect-error a mistyped option would be dropped, so it is an error
    await step.subscribe("typo", { event: order, iff: "async.data.id == 1" });

    // @ts-expect-error a mistyped field of an event in the list
    await step.subscribe("typo-in-list", {
      events: [
        { event: order },
        { event: refund, iff: "async.data.amount > 1" },
      ],
    });

    // @ts-expect-error events and event are alternatives
    await step.subscribe("both", { event: order, events: [{ event: refund }] });

    // Several events: checking the name narrows the data.
    const firstOfMany = await many.next();

    expectTypeOf(firstOfMany?.name).toEqualTypeOf<
      "shop/order.created" | "shop/refund.created" | undefined
    >();

    if (firstOfMany?.name === "shop/order.created") {
      expectTypeOf(firstOfMany.data).toEqualTypeOf<{
        id: string;
        total: number;
      }>();
    } else if (firstOfMany) {
      expectTypeOf(firstOfMany.data).toEqualTypeOf<{
        order: string;
        amount: number;
      }>();
    }

    // A view is typed by its event type, and msg.is() narrows by name and data.
    const orders = one.of(order);
    const viewed = await orders.next();

    expectTypeOf(viewed?.data).toEqualTypeOf<
      { id: string; total: number } | undefined
    >();
    expectTypeOf(viewed?.name).toEqualTypeOf<
      "shop/order.created" | undefined
    >();

    const anything = await many.next();

    if (anything?.is(refund)) {
      expectTypeOf(anything.data).toEqualTypeOf<{
        order: string;
        amount: number;
      }>();
    }

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
      text: "hi",
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
      expect.objectContaining({ event: "agent/steer" }),
      expect.objectContaining({ event: "agent/request" }),
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

    expect(options.triggers[3]).toEqual({ cron: "0 3 * * *" });
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
      'has(event.data._agent) && has(event.data._agent.thread) ? event.data._agent.thread : ("worker")',
    );
    expect(
      compiled[0]?.thread.key({
        name: "inngest/function.invoked",
        data: { _agent: { depth: 1, thread: "t9" } },
      }),
    ).toBe("t9");
    expect(
      compiled[0]?.thread.key({ name: "inngest/function.invoked", data: {} }),
    ).toBe("worker");
    expect(
      compiled[0]?.thread.key({
        name: "inngest/function.invoked",
        data: { _agent: { depth: 1 } },
      }),
    ).toBe("worker");
  });

  test("the agent's own events and mixed triggers are refused", () => {
    expect(() => {
      return compileTriggers("bot", { on: agentMessage });
    }).toThrow(/"agent\/message" is an event the agent layer owns/);
    expect(() => {
      return compileTriggers("bot", { on: agentSteer });
    }).toThrow(/"agent\/steer" is an event the agent layer owns/);
    expect(() => {
      return compileTriggers("bot", { on: skillsBake });
    }).toThrow(/"agent\/skills.bake" is an event the agent layer owns/);
    expect(() => {
      return compileTriggers("bot", {
        on: { event: "inngest/scheduled.timer", thread: '"a"' },
      });
    }).toThrow(/is the event of a cron; use \{ cron \}/);
    expect(() => {
      return compileTriggers("bot", {
        on: { event: "inngest/function.invoked", thread: '"a"' },
      });
    }).toThrow(/use invoke\(schema\)/);
    expect(() => {
      return compileTriggers("bot", {
        on: { event: "shop/*", thread: '"a"' },
      });
    }).toThrow(/is a wildcard/);
    expect(() => {
      return compileTriggers("bot", {
        on: { cron: "* * * * *", event: "shop/x" } as never,
      });
    }).toThrow(/not both/);
  });

  test("only the first of several crons sets session", () => {
    expect(() => {
      return compileTriggers("bot", {
        on: [{ cron: "0 3 * * *" }, { cron: "0 4 * * *", session: '"s"' }],
      });
    }).toThrow(/first cron/);
  });

  test("an event type's name is checked like a name", () => {
    expect(() => {
      return compileTriggers("bot", { on: agentMessage });
    }).toThrow(/"agent\/message" is an event the agent layer owns/);
  });
});

describe("inbox validation", () => {
  const makeAgent = () => {
    return createAgentFunction(
      client,
      {
        id: "checked",
        kv: createKv({ adapter: memoryKvAdapter() }),
        on: {
          event: order,
          thread: "event.data.id",
        },
      },
      async ({ inbox }) => {
        const first = await inbox.next();
        const second = await inbox.next();
        const word = (message: typeof first) => {
          const data = message?.data as
            | { id: string; total: number }
            | undefined;

          return data ? `order ${data.id} ${data.total}` : undefined;
        };

        return [word(first), word(second)];
      },
    );
  };

  const event = (id: unknown, total: unknown) => {
    return { name: "shop/order.created", data: { id, total } };
  };

  test("an event that breaks the schema is dropped, a valid one is delivered", async () => {
    const { output } = await run(makeAgent().fn, {
      event: event("a", 1),
      saved: [event("a", "not a number"), event("a", 3)],
    });

    expect(output).toEqual(["order a 1", "order a 3"]);
  });

  test("a schema that throws drops the event and the run carries on", async () => {
    const throwingEvent = eventType("shop/throwing", {
      schema: {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (value: unknown) => {
            if ((value as { bad?: boolean }).bad) {
              throw new Error("refine blew up");
            }

            return { value };
          },
        },
      } as StandardSchemaV1<{ id: string; bad?: boolean; ok?: number }>,
    });
    const { output } = await run(
      createAgentFunction(
        client,
        {
          id: "throwing",
          kv: createKv({ adapter: memoryKvAdapter() }),
          on: { event: throwingEvent, thread: "event.data.id" },
        } as never,
        async ({ inbox }) => {
          await inbox.next();

          return (await inbox.next())?.data;
        },
      ).fn,
      {
        event: { name: "shop/throwing", data: { id: "a" } },
        saved: [
          { name: "shop/throwing", data: { id: "a", bad: true } },
          { name: "shop/throwing", data: { id: "a", ok: 1 } },
        ],
      },
    );

    expect(output).toEqual({ id: "a", ok: 1 });
  });

  test("a drop is logged once, however often the run replays", async () => {
    const warn = vi.spyOn(
      (client as unknown as Record<symbol, { warn: (m: string) => void }>)[
        Symbol.for("inngest.internalLogger")
      ] as { warn: (m: string) => void },
      "warn",
    );

    await run(makeAgent().fn, {
      event: event("a", 1),
      saved: [{ ...event("a", "bad"), id: "evt-warn-once" }, event("a", 3)],
    });

    expect(
      warn.mock.calls.filter(([message]) => {
        return String(message).includes("Dropped");
      }),
    ).toHaveLength(1);
    warn.mockRestore();
  });

  test("close() returns only the unread events that pass their schema", async () => {
    const { output } = await run(
      createAgentFunction(
        client,
        {
          id: "closing",
          kv: createKv({ adapter: memoryKvAdapter() }),
          on: { event: order, thread: "event.data.id" },
        },
        async ({ inbox }) => {
          await inbox.next();
          const unread = await inbox.close();

          return unread.map((message) => {
            return message.data;
          });
        },
      ).fn,
      {
        event: event("a", 1),
        saved: [event("a", "bad"), event("a", 4)],
      },
    );

    expect(output).toEqual([{ id: "a", total: 4 }]);
  });

  test("an event type without a schema delivers everything", async () => {
    const { output } = await run(
      createAgentFunction(
        client,
        {
          id: "unchecked",
          kv: createKv({ adapter: memoryKvAdapter() }),
          on: { event: ping, thread: "event.data.id" },
        },
        async ({ inbox }) => {
          await inbox.next();

          return (await inbox.next())?.data;
        },
      ).fn,
      {
        event: { name: "shop/ping", data: { id: "a" } },
        saved: [{ name: "shop/ping", data: { id: "a", anything: 1 } }],
      },
    );

    expect(output).toEqual({ id: "a", anything: 1 });
  });
});

describe("schemaProblem", () => {
  const triggers = compileTriggers("bot", {
    on: { event: order, thread: "event.data.id" },
  });

  const throwing = (message: string) => {
    return {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => {
          throw new Error(message);
        },
      },
    } as never;
  };

  test("names the field and the problem, or nothing when the data is fine", async () => {
    expect(
      await schemaProblem(triggers, { data: { id: "a", total: 1 } }),
    ).toBeUndefined();
    expect(
      await schemaProblem(triggers, { data: { id: "a", total: "x" } }),
    ).toMatch(/total/);
    expect(await schemaProblem(triggers, {})).toMatch(/id/);
  });

  test("a trigger without a schema, or no trigger, has no problem", async () => {
    const plain = compileTriggers("bot", {
      on: { event: "shop/x", thread: "event.data.id" },
    });

    expect(await schemaProblem(plain, { data: 1 })).toBeUndefined();
    expect(await schemaProblem([], { data: 1 })).toBeUndefined();
  });

  test("a schema that throws rejects the event instead of throwing", async () => {
    const [trigger] = triggers;
    const bad = [{ ...trigger, schema: throwing("boom") }] as never;

    expect(await schemaProblem(bad, { data: {} })).toMatch(
      /the schema threw: boom/,
    );
  });

  test("triggers that share an event name: fine when any accepts, a problem when none does", async () => {
    const [trigger] = triggers;
    const strict = trigger as never;
    const loose = {
      ...trigger,
      schema: z.object({ id: z.string() }),
    } as never;
    const none = { ...trigger, schema: undefined } as never;

    expect(
      await schemaProblem([strict, loose], { data: { id: "a", total: "x" } }),
    ).toBeUndefined();
    expect(
      await schemaProblem([strict, strict], { data: { id: "a", total: "x" } }),
    ).toMatch(/total.*; .*total/);
    expect(
      await schemaProblem([strict, none], { data: { id: "a", total: "x" } }),
    ).toBeUndefined();
  });
});
