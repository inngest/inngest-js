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

    test("create with transform", async () => {
      const et = eventType("event-1").withSchema(
        z.object({ name: z.string() }).transform((val) => {
          return {
            ...val,
            nameLength: val.name.length,
          };
        }),
      );

      const created = et.create({ data: { name: "John" } });

      // Note that the data is pre-transform
      expect(created.data).toEqual({ name: "John" });
      expectTypeOf(created.data).toEqualTypeOf<{ name: string }>();

      const validated = await created.validate();

      // Note that the data is post-transform
      expect(validated.data).toEqual({ name: "John", nameLength: 4 });
      expectTypeOf(validated.data).toEqualTypeOf<{
        name: string;
        nameLength: number;
      }>();
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
        },
      );
    });
  });

  describe("with schema", () => {
    const et = eventType("event-1").withSchema(
      z.object({ message: z.string() }),
    );

    test("return", () => {
      expect(et.event).toBe("event-1");
      expectTypeOf(et.event).toEqualTypeOf<"event-1">();

      expect(et.name).toBe("event-1");
      expectTypeOf(et.name).toEqualTypeOf<"event-1">();

      expect(et.schema).toBeDefined();
      expectTypeOf(et.schema).not.toBeAny();
      expectTypeOf(et.schema).toExtend<
        StandardSchemaV1<{ message: string }, { message: string }>
      >();
    });

    test("create", async () => {
      const created1 = et.create({ data: { message: "hello" } });
      expect(created1.v).toBe("1.0.0");
      expectTypeOf(created1.v).not.toBeAny();
      expectTypeOf(created1.v).toEqualTypeOf<string | undefined>();

      const created2 = et.create({
        data: { message: "hello" },
        id: "123",
        ts: 1715769600,
        v: "1.0.0",
      });
      expect(created2.data).toEqual({ message: "hello" });
      expectTypeOf(created2.data).not.toBeAny();
      expectTypeOf(created2.data).toExtend<{ message: string }>();
      expect(created2.id).toBe("123");
      expectTypeOf(created2.id).toEqualTypeOf<string | undefined>();
      expect(created2.ts).toBe(1715769600);
      expectTypeOf(created2.ts).toEqualTypeOf<number | undefined>();
      expect(created2.v).toBe("1.0.0");
      expectTypeOf(created2.v).toEqualTypeOf<string | undefined>();

      // @ts-expect-error - Missing data
      let event = et.create({});
      await expect(event.validate()).rejects.toThrowError("data is required");

      // @ts-expect-error - Invalid data
      event = et.create({ data: { foo: "bar" } });
      await expect(event.validate()).rejects.toThrowError("message: Required");
    });

    test("createFunction", () => {
      const inngest = new Inngest({ id: "app" });
      inngest.createFunction(
        {
          id: "fn",

          // Can use the event type as a cancellation event
          cancelOn: [et],
        },

        // Can use the event type as a trigger
        et,
        ({ event, step }) => {
          expectTypeOf(event.name).toEqualTypeOf<
            "event-1" | "inngest/function.invoked"
          >();
          expectTypeOf(event.data).toEqualTypeOf<{ message: string }>();

          step.waitForEvent("id", {
            ...et,
            timeout: 1000,
          });
        },
      );
    });

    test("multiple event types", () => {
      const inngest = new Inngest({ id: "app" });
      inngest.createFunction(
        { id: "fn" },
        [
          eventType("event-1").withSchema(z.object({ a: z.string() })),
          eventType("event-2").withSchema(z.object({ b: z.number() })),
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
        },
      );
    });

    test("withIf", () => {
      const et = eventType("event-1")
        .withSchema(z.object({ foo: z.string() }))
        .withIf("event.data.foo == 'bar'");
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

      const et = eventType("event-1").withSchema(schema);
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

  test("withVersion", () => {
    // Can set the event type version
    const et = eventType("event-1").withVersion("1.0.0");
    expect(et.version).toBe("1.0.0");
    expectTypeOf(et.version).toEqualTypeOf<"1.0.0">();

    // Defaults to event type version
    const created = et.create({});
    expect(created.v).toBe("1.0.0");
    expectTypeOf(created.v).toEqualTypeOf<string | undefined>();

    // Can override the version
    const createdWithVersion = et.create({ v: "2.0.0" });
    expect(createdWithVersion.v).toBe("2.0.0");
    expectTypeOf(createdWithVersion.v).toEqualTypeOf<string | undefined>();

    // withSchema retains the version
    const etWithSchema = et.withSchema(z.object({ message: z.string() }));
    expect(etWithSchema.version).toBe("1.0.0");
    expectTypeOf(etWithSchema.version).toEqualTypeOf<"1.0.0">();
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
      },
    );
  });
});

describe("mixed triggers", () => {
  test("multiple of each kind", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      { id: "fn" },
      [
        eventType("event-1").withSchema(z.object({ a: z.string() })),
        cron("* * * * *"),
        invoke(z.object({ name: z.string() })),
        eventType("event-2").withSchema(z.object({ b: z.number() })),
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
      },
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
      },
    );
  });

  test("event type and invoke", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      { id: "fn" },
      [
        eventType("event-1").withSchema(z.object({ a: z.string() })),
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
      },
    );
  });
});
