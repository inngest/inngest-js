// biome-ignore-all lint/suspicious/noExplicitAny: it's fine

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { Inngest } from "../Inngest.ts";
import { cron, eventType, invoke } from "./triggers.ts";

describe("cron", () => {
  test("return", () => {
    const c = cron("* * * * *");
    expect(c.cron).toBe("* * * * *");
    expectTypeOf(c.cron).toEqualTypeOf<"* * * * *">();
  });

  test("createFunction", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction({ id: "fn" }, cron("* * * * *"), ({ event }) => {
      expectTypeOf(event.name).toEqualTypeOf<
        "inngest/scheduled.timer" | "inngest/function.invoked"
      >();
      expectTypeOf(event.data).toEqualTypeOf<{}>();
    });
  });
});

describe("eventType", () => {
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
      et.create({
        data: { foo: "bar" },
        id: "123",
        ts: 1715769600,
        v: "1.0.0",
      });
    });

    test("createFunction", () => {
      const inngest = new Inngest({ id: "app" });

      inngest.createFunction({ id: "fn" }, et, () => {});

      inngest.createFunction(
        { id: "fn2" },
        et.withIf("event.data.foo == 'bar'"),
        ({ event }) => {
          expectTypeOf(event.name).toEqualTypeOf<
            "event-1" | "inngest/function.invoked"
          >();

          expectTypeOf(event.data).toEqualTypeOf<Record<string, any>>();
        }
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
      expectTypeOf(et.schema).toExtend<
        StandardSchemaV1<{ message: string }, { message: string }>
      >();
    });

    test("create", async () => {
      et.create({ data: { message: "hello" } });
      et.create({
        data: { message: "hello" },
        id: "123",
        ts: 1715769600,
        v: "1.0.0",
      });

      // @ts-expect-error - Missing data
      let event = et.create({});
      await expect(event.validate()).rejects.toThrowError("data is required");

      // @ts-expect-error - Invalid data
      event = et.create({ data: { foo: "bar" } });
      await expect(event.validate()).rejects.toThrowError("message: Required");
    });

    test("createFunction", () => {
      const inngest = new Inngest({ id: "app" });
      inngest.createFunction({ id: "fn" }, et, ({ event }) => {
        expectTypeOf(event.name).toEqualTypeOf<
          "event-1" | "inngest/function.invoked"
        >();
        expectTypeOf(event.data).toEqualTypeOf<{ message: string }>();
      });
    });

    test("multiple event types", () => {
      const inngest = new Inngest({ id: "app" });
      inngest.createFunction(
        { id: "fn" },
        [
          eventType("event-1", z.object({ a: z.string() })),
          eventType("event-2", z.object({ b: z.number() })),
        ] as const,
        ({ event }) => {
          expectTypeOf(event.name).toEqualTypeOf<
            "event-1" | "event-2" | "inngest/function.invoked"
          >();

          expectTypeOf(event.data).toEqualTypeOf<
            { a: string } | { b: number }
          >();

          if (event.name === "event-1") {
            expectTypeOf(event.data).toEqualTypeOf<{ a: string }>();
          } else if (event.name === "event-2") {
            expectTypeOf(event.data).toEqualTypeOf<{ b: number }>();
          } else if (event.name === "inngest/function.invoked") {
            expectTypeOf(event.data).toEqualTypeOf<
              { a: string } | { b: number }
            >();
          }
        }
      );
    });

    test("withIf", () => {
      const et = eventType("event-1", z.object({ foo: z.string() })).withIf(
        "event.data.foo == 'bar'"
      );
      expect(et.if).toBe("event.data.foo == 'bar'");
      expectTypeOf(et.if).toEqualTypeOf<"event.data.foo == 'bar'">();

      const inngest = new Inngest({ id: "app" });
      inngest.createFunction({ id: "fn" }, et, ({ event }) => {
        expectTypeOf(event.name).toEqualTypeOf<
          "event-1" | "inngest/function.invoked"
        >();
        expectTypeOf(event.data).toEqualTypeOf<{ foo: string }>();
      });
    });

    test("input schema and output schema are different", () => {
      // When `z.transform` is used, the input schema and output schema are
      // different

      const schema = z.object({ message: z.string() }).transform((val) => {
        return {
          messageLength: val.message.length,
        };
      });

      const et = eventType("event-1", schema);
      et.create({ data: { message: "hello" } });
      et.create({
        data: { message: "hello" },
        id: "123",
        ts: 1715769600,
        v: "1.0.0",
      });

      const inngest = new Inngest({ id: "app" });
      inngest.createFunction({ id: "fn" }, et, ({ event }) => {
        expectTypeOf(event.name).toEqualTypeOf<
          "event-1" | "inngest/function.invoked"
        >();
        event.data;
        expectTypeOf(event.data).toEqualTypeOf<{ messageLength: number }>();
      });
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
      ({ event }) => {
        expectTypeOf(event.name).toEqualTypeOf<"inngest/function.invoked">();
        expectTypeOf(event.data).toEqualTypeOf<{ message: string }>();
      }
    );
  });
});

describe("mixed triggers", () => {
  test("multiple of each kind", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      { id: "fn" },
      [
        eventType("event-1", z.object({ a: z.string() })),
        cron("* * * * *"),
        invoke(z.object({ name: z.string() })),
        eventType("event-2", z.object({ b: z.number() })),
        cron("0 0 * * *"),
        invoke(z.object({ age: z.number() })),
      ] as const,
      ({ event }) => {
        expectTypeOf(event.name).toEqualTypeOf<
          | "event-1"
          | "event-2"
          | "inngest/scheduled.timer"
          | "inngest/function.invoked"
        >();

        expectTypeOf(event.data).toEqualTypeOf<
          | { a: string }
          | { b: number }
          | { name: string }
          | { age: number }
          | {}
        >();

        // Can type narrow the data type based on the event name
        if (event.name === "event-1") {
          expectTypeOf(event.data).toEqualTypeOf<{ a: string }>();
        } else if (event.name === "event-2") {
          expectTypeOf(event.data).toEqualTypeOf<{ b: number }>();
        } else if (event.name === "inngest/scheduled.timer") {
          expectTypeOf(event.data).toEqualTypeOf<{}>();
        } else if (event.name === "inngest/function.invoked") {
          expectTypeOf(event.data).toEqualTypeOf<
            { name: string } | { age: number }
          >();
        }
      }
    );
  });

  test("object literals instead of trigger creation functions", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      { id: "fn" },
      [
        { event: "event-1", schema: z.object({ a: z.string() }) },
        { cron: "0 0 * * *" },
      ] as const,
      ({ event }) => {
        expectTypeOf(event.name).toEqualTypeOf<
          "event-1" | "inngest/scheduled.timer" | "inngest/function.invoked"
        >();
        expectTypeOf(event.data).toEqualTypeOf<{ a: string } | {}>();

        // Can type narrow the data type based on the event name
        if (event.name === "event-1") {
          expectTypeOf(event.data).toEqualTypeOf<{ a: string }>();
        } else if (event.name === "inngest/scheduled.timer") {
          expectTypeOf(event.data).toEqualTypeOf<{}>();
        } else if (event.name === "inngest/function.invoked") {
          expectTypeOf(event.data).toEqualTypeOf<{ a: string }>();
        }
      }
    );
  });

  test("event type and invoke", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      { id: "fn" },
      [
        eventType("event-1", z.object({ a: z.string() })),
        invoke(z.object({ b: z.number() })),
      ] as const,
      ({ event }) => {
        expectTypeOf(event.name).toEqualTypeOf<
          "event-1" | "inngest/function.invoked"
        >();
        expectTypeOf(event.data).toEqualTypeOf<{ a: string } | { b: number }>();

        if (event.name === "event-1") {
          expectTypeOf(event.data).toEqualTypeOf<{ a: string }>();
        } else if (event.name === "inngest/function.invoked") {
          expectTypeOf(event.data).toEqualTypeOf<{ b: number }>();
        }
      }
    );
  });
});
