import { describe, expect, test } from "vitest";
import { z } from "zod";
import { cron, eventType, invoke } from "./trigger2.ts";
import { Inngest } from "./Inngest.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";

describe("cron", () => {
  test("return", () => {
    const c = cron("* * * * *");
    expect(c.cron).toBe("* * * * *");
    expectTypeOf(c.cron).toEqualTypeOf<"* * * * *">();
  });

  test("createFunction", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction({ id: "fn" }, cron("* * * * *"), () => {});
  });
});

describe("eventType", () => {
  test("withIf", () => {
    const et = eventType("event-1").withIf("event.data.foo == 'bar'");
    expect(et.if).toBe("event.data.foo == 'bar'");
    expectTypeOf(et.if).toEqualTypeOf<"event.data.foo == 'bar'">();
  });

  describe("without schema", () => {
    const et = eventType("event-1");

    test("return", () => {
      expect(et.event).toBe("event-1");
      expectTypeOf(et.event).toEqualTypeOf<"event-1">();

      expect(et.name).toBe("event-1");
      expectTypeOf(et.name).toEqualTypeOf<"event-1">();

      expect(et.schema).toBeUndefined();
      expectTypeOf(et.schema).toEqualTypeOf<undefined>();
    });

    test("create", () => {
      et.create({});
      et.create({ data: { foo: "bar" } });
    });

    test("createFunction", () => {
      const inngest = new Inngest({ id: "app" });

      inngest.createFunction({ id: "fn" }, et, () => {});

      inngest.createFunction(
        { id: "fn2" },
        et.withIf("event.data.foo == 'bar'"),
        () => {}
      );
    });
  });

  describe("with schema", () => {
    const et = eventType("event-1", z.object({ message: z.string() }));

    test("return", () => {
      expect(et.event).toBe("event-1");
      expectTypeOf(et.event).toEqualTypeOf<"event-1">();

      expect(et.name).toBe("event-1");
      expectTypeOf(et.name).toEqualTypeOf<"event-1">();

      expect(et.schema).toBeDefined();
      expectTypeOf(et.schema).toEqualTypeOf<
        StandardSchemaV1<{ message: string }>
      >();
    });

    test("create", async () => {
      et.create({ data: { message: "hello" } });

      // const promise = Promise.reject(new Error('Test'))
      // await expect(promise).rejects.toThrowError()

      // @ts-expect-error - Missing data
      let event = et.create({});
      await expect(event.validate()).rejects.toThrowError("data is required");

      // @ts-expect-error - Invalid data
      event = et.create({ data: { foo: "bar" } });
      await expect(event.validate()).rejects.toThrowError("message: Required");
    });
  });
});

describe("invoke", () => {
  test("return", () => {
    const inv = invoke(z.object({ message: z.string() }));
    expect(inv.event).toBe("inngest/function.invoked");
    expectTypeOf(inv.event).toEqualTypeOf<"inngest/function.invoked">();

    expect(inv.schema).toBeDefined();
    expectTypeOf(inv.schema).toEqualTypeOf<
      StandardSchemaV1<{ message: string }>
    >();
  });

  test("createFunction", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      { id: "fn" },
      invoke(z.object({ message: z.string() })),
      () => {}
    );
  });
});

describe("type inference from triggers", () => {
  test("handler receives typed event from trigger schema", () => {
    const inngest = new Inngest({ id: "app" });
    const userCreated = eventType(
      "my-event",
      z.object({
        email: z.string(),
        userId: z.string(),
      })
    );

    inngest.createFunction({ id: "fn" }, userCreated, ({ event }) => {
      expectTypeOf(event.data).toEqualTypeOf<{
        email: string;
        userId: string;
      }>();
      expectTypeOf(event.name).toEqualTypeOf<"my-event">();
    });
  });

  test("multiple triggers create union type", () => {
    const inngest = new Inngest({ id: "app" });
    const event1 = eventType("event-1", z.object({ a: z.string() }));
    const event2 = eventType("event-2", z.object({ b: z.number() }));

    inngest.createFunction({ id: "fn" }, [event1, event2], ({ event }) => {
      // event is a union
      expectTypeOf(event).toEqualTypeOf<
        | { name: "event-1"; data: { a: string } }
        | { name: "event-2"; data: { b: number } }
      >();

      // User can narrow the type
      if (event.name === "event-1") {
        expectTypeOf(event.data).toEqualTypeOf<{ a: string }>();
      } else {
        expectTypeOf(event.data).toEqualTypeOf<{ b: number }>();
      }
    });
  });

  test("trigger without schema uses Record<string, any>", () => {
    const inngest = new Inngest({ id: "app" });
    const untyped = eventType("my-event");

    inngest.createFunction({ id: "fn" }, untyped, ({ event }) => {
      expectTypeOf(event.data).toEqualTypeOf<Record<string, any>>();
      expectTypeOf(event.name).toEqualTypeOf<"my-event">();
    });
  });

  test("cron trigger works without schema", () => {
    const inngest = new Inngest({ id: "app" });

    inngest.createFunction({ id: "fn" }, cron("0 0 * * *"), ({ event }) => {
      expectTypeOf(event.name).toEqualTypeOf<"inngest/scheduled.timer">();
    });
  });

  test("invoke trigger with schema provides typed data", () => {
    const inngest = new Inngest({ id: "app" });

    inngest.createFunction(
      { id: "fn" },
      invoke(z.object({ payload: z.string() })),
      ({ event }) => {
        expectTypeOf(event.data).toEqualTypeOf<{ payload: string }>();
        expectTypeOf(event.name).toEqualTypeOf<"inngest/function.invoked">();
      }
    );
  });

  test("mixed triggers with and without schemas", () => {
    const inngest = new Inngest({ id: "app" });
    const typed = eventType("typed", z.object({ x: z.number() }));
    const untyped = eventType("untyped");

    inngest.createFunction({ id: "fn" }, [typed, untyped], ({ event }) => {
      expectTypeOf(event).toEqualTypeOf<
        | { name: "typed"; data: { x: number } }
        | { name: "untyped"; data: Record<string, any> }
      >();
    });
  });

  test("EventType with withIf maintains typing", () => {
    const inngest = new Inngest({ id: "app" });
    const conditional = eventType(
      "conditional",
      z.object({ count: z.number() })
    ).withIf("event.data.count > 10");

    inngest.createFunction({ id: "fn" }, conditional, ({ event }) => {
      expectTypeOf(event.data).toEqualTypeOf<{ count: number }>();
      expectTypeOf(event.name).toEqualTypeOf<"conditional">();
    });
  });

  test("plain event object trigger with schema", () => {
    const inngest = new Inngest({ id: "app" });

    inngest.createFunction(
      { id: "fn" },
      {
        event: "plain-event",
        schema: z.object({ value: z.boolean() }),
      } as const,
      ({ event }) => {
        expectTypeOf(event.data).toEqualTypeOf<{ value: boolean }>();
        expectTypeOf(event.name).toEqualTypeOf<"plain-event">();
      }
    );
  });
});
