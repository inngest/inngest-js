/**
 * @module
 * Tests that the agent layer works with core's `eventType()`: the triggers
 * of an agent take every shape a function's triggers take and type the
 * events from them, the agent's own events are event types, and a cron
 * starts a thread of its own.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { eventType, invoke } from "../../../components/triggers/triggers.ts";
import { testClientId } from "../../../test/helpers.ts";
import { agentMessage } from "../inbox/events.ts";
import { createKv, memoryKvAdapter } from "../kv/kv.ts";
import { agentMessageEvent } from "../threads/thread.ts";
import {
  compileTriggers,
  schemaProblem,
  singletonKey,
} from "../threads/threadTrigger.ts";
import { createAgentFunction } from "./agentFunction.ts";
import { createAgents } from "./agents.ts";
import { freshKv, run } from "./test-helpers.ts";

beforeEach(() => {
  freshKv();
});

const order = eventType("shop/order.created", {
  schema: z.object({ id: z.string(), total: z.number() }),
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
      { id: "t1", triggers: { event: "shop/x", thread: "event.data.id" } },
      noop,
    );
    agents.agent(
      { id: "t2", triggers: { event: order, thread: "event.data.id" } },
      noop,
    );
    agents.agent({ id: "t3", triggers: order, thread: "event.data.id" }, noop);
    agents.agent({ id: "t4", triggers: { cron: "0 * * * *" } }, noop);
    agents.agent(
      {
        id: "t5",
        triggers: [
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
      return agents.agent({ id: "t9", triggers: ["shop/x"] }, noop);
    }).toThrow(/takes triggers/);
  });

  test("the agent's events are event types with typed data", () => {
    expectTypeOf(agentMessage.name).toEqualTypeOf<"agent/message">();
    expectTypeOf(agentMessageEvent).toEqualTypeOf<"agent/message">();
    expectTypeOf<
      Extract<Parameters<typeof agentMessage.create>[0], { content: unknown }>
    >().toHaveProperty("content");

    // @ts-expect-error a message needs its thread
    agentMessage.create({ agent: "app/bot", content: "hi" });
  });
});

describe("events", () => {
  test("the agent's events keep their names", () => {
    expect(agentMessage.name).toBe("agent/message");
  });

  test("a created message carries the schema it is validated against", async () => {
    const message = agentMessage.create({
      agent: "app/bot",
      thread: "t1",
      content: "hi",
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
        triggers: [
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
      expect.objectContaining({ event: "agent/recover" }),
      expect.objectContaining({ event: "agent/question" }),
      expect.objectContaining({ event: "agent/answer" }),
      expect.objectContaining({ event: "agent/finished" }),
      expect.objectContaining({ event: "agent/report" }),
      { event: order, if: "event.data.total > 5" },
      { event: ping },
    ]);
  });

  test("a cron starts one thread per agent by default", () => {
    const compiled = compileTriggers("nightly", {
      triggers: { cron: "0 3 * * *" },
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
      triggers: [
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
        triggers: [
          { cron: "0 3 * * *", thread: '"a"' },
          { cron: "0 4 * * *", thread: '"b"' },
        ],
      });
    }).toThrow(/share one thread key/);

    expect(
      compileTriggers("bot", {
        triggers: [{ cron: "0 3 * * *" }, { cron: "0 4 * * *" }],
      }),
    ).toHaveLength(2);
  });

  test("the singleton is keyed on the cron's thread", () => {
    const agent = agents.agent(
      { id: "u2", triggers: { cron: "0 3 * * *" } },
      noop,
    );
    const options = fnOptions(agent.fn);

    expect(options.triggers[6]).toEqual({ cron: "0 3 * * *" });
    expect(options.singleton.key).toBe(
      'event.name == "inngest/scheduled.timer" ? ("u2") : event.name == "agent/report" ? event.data["::agents"].thread : event.data.thread',
    );
    expect(
      singletonKey(compileTriggers("u2", { triggers: { cron: "0 3 * * *" } })),
    ).toBe(options.singleton.key);
  });

  test("an invoke trigger makes the agent invokable, one thread per agent", () => {
    const compiled = compileTriggers("worker", {
      triggers: invoke(z.object({ question: z.string() })),
    });

    expect(compiled[0]?.listen).toBe(false);
    expect(compiled[0]?.thread.source).toBe(
      'has(event.data.from) && has(event.data.from.thread) ? event.data.from.thread : ("worker")',
    );
    expect(
      compiled[0]?.thread.key({
        name: "inngest/function.invoked",
        data: { from: { depth: 1, thread: "t9" } },
      }),
    ).toBe("t9");
    expect(
      compiled[0]?.thread.key({ name: "inngest/function.invoked", data: {} }),
    ).toBe("worker");
    expect(
      compiled[0]?.thread.key({
        name: "inngest/function.invoked",
        data: { from: { depth: 1 } },
      }),
    ).toBe("worker");
  });

  test("the agent's own events and mixed triggers are refused", () => {
    expect(() => {
      return compileTriggers("bot", { triggers: agentMessage });
    }).toThrow(/"agent\/message" is an event the agent layer owns/);
    expect(() => {
      return compileTriggers("bot", {
        triggers: { event: "inngest/scheduled.timer", thread: '"a"' },
      });
    }).toThrow(/is the event of a cron; use \{ cron \}/);
    expect(() => {
      return compileTriggers("bot", {
        triggers: { event: "inngest/function.invoked", thread: '"a"' },
      });
    }).toThrow(/use invoke\(schema\)/);
    expect(() => {
      return compileTriggers("bot", {
        triggers: { event: "shop/*", thread: '"a"' },
      });
    }).toThrow(/is a wildcard/);
    expect(() => {
      return compileTriggers("bot", {
        triggers: { cron: "* * * * *", event: "shop/x" } as never,
      });
    }).toThrow(/not both/);
  });

  test("an event type's name is checked like a name", () => {
    expect(() => {
      return compileTriggers("bot", { triggers: agentMessage });
    }).toThrow(/"agent\/message" is an event the agent layer owns/);
  });
});

describe("inbox validation", () => {
  const makeAgent = () => {
    return createAgentFunction(
      client,
      {
        id: "checked",
        triggers: {
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
          triggers: { event: throwingEvent, thread: "event.data.id" },
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
          triggers: { event: order, thread: "event.data.id" },
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
          triggers: { event: ping, thread: "event.data.id" },
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
    triggers: { event: order, thread: "event.data.id" },
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
      triggers: { event: "shop/x", thread: "event.data.id" },
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
