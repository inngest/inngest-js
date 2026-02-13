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
    expectTypeOf(c.cron).not.toBeAny();
    expectTypeOf(c.cron).toEqualTypeOf<"* * * * *">();
  });

  test("createFunction", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      { id: "fn", triggers: [cron("* * * * *")] },
      ({ event }) => {
        expectTypeOf(event.name).not.toBeAny();
        expectTypeOf(event.name).toEqualTypeOf<
          "inngest/scheduled.timer" | "inngest/function.invoked"
        >();

        expectTypeOf(event.data).not.toBeAny();
        expectTypeOf(event.data).toEqualTypeOf<
          | {
              cron: string;
            }
          | {}
        >();
      },
    );
  });

  test("step.invoke", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction({ id: "parent", triggers: [] }, async ({ step }) => {
      await step.invoke("invoke", {
        function: child,
        data: { message: "hello" },
      });

      await step.invoke("invoke", {
        function: child,
      });
    });

    const child = inngest.createFunction(
      { id: "child", triggers: [cron("* * * * *")] },
      () => {},
    );
  });
});

describe("eventType without options", () => {
  const et = eventType("event-1");

  test("return", () => {
    expect(et.event).toBe("event-1");
    expectTypeOf(et.event).not.toBeAny();
    expectTypeOf(et.event).toEqualTypeOf<"event-1">();

    expect(et.name).toBe("event-1");
    expectTypeOf(et.name).not.toBeAny();
    expectTypeOf(et.name).toEqualTypeOf<"event-1">();

    expect(et.schema).toBeUndefined();
    expectTypeOf(et.schema).not.toBeAny();
    expectTypeOf(et.schema).toEqualTypeOf<undefined>();
  });

  test("create", () => {
    et.create();
    et.create({ foo: "bar" });
    et.create(
      { foo: "bar" },
      {
        id: "123",
        ts: 1715769600,
        v: "1.0.0",
      },
    );
  });

  test("schema transform", async () => {
    eventType("event-1", {
      // @ts-expect-error - Transforms are not supported
      schema: z.object({ input: z.string() }).transform((val) => {
        return { output: val.input.length };
      }),
    });
  });

  test("function trigger", () => {
    const inngest = new Inngest({ id: "app" });

    // Without condition
    inngest.createFunction({ id: "fn", triggers: [et] }, ({ event }) => {
      expectTypeOf(event.name).not.toBeAny();
      expectTypeOf(event.name).toEqualTypeOf<
        "event-1" | "inngest/function.invoked"
      >();

      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data).toEqualTypeOf<Record<string, any>>();
    });

    // With condition
    inngest.createFunction(
      {
        id: "fn2",
        triggers: [
          {
            event: et,
            if: "event.data.foo == 'bar'",
          },
        ],
      },
      ({ event }) => {
        expectTypeOf(event.name).not.toBeAny();
        expectTypeOf(event.name).toEqualTypeOf<
          "event-1" | "inngest/function.invoked"
        >();

        expectTypeOf(event.data).not.toBeAny();
        expectTypeOf(event.data).toEqualTypeOf<Record<string, any>>();
      },
    );
  });

  test("function options", () => {
    const inngest = new Inngest({ id: "app" });

    // Without condition
    inngest.createFunction(
      {
        id: "fn",
        cancelOn: [et],
        triggers: [et],
      },
      () => {},
    );

    // With condition
    inngest.createFunction(
      {
        id: "fn2",
        cancelOn: [{ event: et, if: "event.data.foo == 'bar'" }],
        triggers: [et],
      },
      () => {},
    );
  });

  test("step.invoke", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction({ id: "parent", triggers: [] }, async ({ step }) => {
      await step.invoke("invoke", {
        function: child,
        data: { message: "hello" },
      });

      await step.invoke("invoke", {
        function: child,
      });
    });

    const child = inngest.createFunction(
      { id: "child", triggers: [et] },
      () => {},
    );
  });

  test("step.waitForEvent", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction({ id: "fn", triggers: [et] }, async ({ step }) => {
      const matched = await step.waitForEvent("id", {
        event: et,
        timeout: 1000,
      });
      expectTypeOf(matched).not.toBeAny();
      expectTypeOf(matched).toEqualTypeOf<{
        name: "event-1";
        data: Record<string, any>;
        id: string;
        ts: number;
        v?: string;
      } | null>();
    });
  });
});

describe("eventType with schema", () => {
  const et = eventType("event-1", {
    schema: z.object({ msg: z.string() }),
  });

  test("return", () => {
    expect(et.event).toBe("event-1");
    expectTypeOf(et.event).not.toBeAny();
    expectTypeOf(et.event).toEqualTypeOf<"event-1">();

    expect(et.name).toBe("event-1");
    expectTypeOf(et.name).not.toBeAny();
    expectTypeOf(et.name).toEqualTypeOf<"event-1">();

    expect(et.schema).toBeDefined();
    expectTypeOf(et.schema).not.toBeAny();
    expectTypeOf(et.schema).toExtend<StandardSchemaV1<{ msg: string }>>();
  });

  test("create", async () => {
    const created1 = et.create({ msg: "hello" });
    expect(created1.v).toBeUndefined();
    expectTypeOf(created1.v).not.toBeAny();
    expectTypeOf(created1.v).toEqualTypeOf<string | undefined>();

    const created2 = et.create(
      { msg: "hello" },
      {
        id: "123",
        ts: 1715769600,
        v: "1.0.0",
      },
    );
    expect(created2.data).toEqual({ msg: "hello" });
    expectTypeOf(created2.data).not.toBeAny();
    expectTypeOf(created2.data).toEqualTypeOf<{ msg: string }>();
    expect(created2.id).toBe("123");
    expectTypeOf(created2.id).not.toBeAny();
    expectTypeOf(created2.id).toEqualTypeOf<string | undefined>();
    expect(created2.ts).toBe(1715769600);
    expectTypeOf(created2.ts).not.toBeAny();
    expectTypeOf(created2.ts).toEqualTypeOf<number | undefined>();
    expect(created2.v).toBe("1.0.0");
    expectTypeOf(created2.v).not.toBeAny();
    expectTypeOf(created2.v).toEqualTypeOf<string | undefined>();

    await created2.validate();

    // @ts-expect-error - Missing data
    let event = et.create();
    await expect(event.validate()).rejects.toThrowError("data is required");

    // @ts-expect-error - Invalid data
    event = et.create({ foo: "bar" });
    await expect(event.validate()).rejects.toThrowError("msg: Required");
  });

  test("function trigger", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction({ id: "fn", triggers: [et] }, ({ event }) => {
      expectTypeOf(event.name).not.toBeAny();
      expectTypeOf(event.name).toEqualTypeOf<
        "event-1" | "inngest/function.invoked"
      >();
      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data).toEqualTypeOf<{ msg: string }>();
    });
  });

  test("step.invoke", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction({ id: "parent", triggers: [] }, async ({ step }) => {
      await step.invoke("invoke", {
        function: child,
        data: { msg: "hello" },
      });

      await step.invoke("invoke", {
        function: child,

        // @ts-expect-error - Invalid data
        data: { wrong: "data" },
      });

      // @ts-expect-error - Missing data
      await step.invoke("invoke", {
        function: child,
      });
    });

    const child = inngest.createFunction(
      { id: "child", triggers: [et] },
      () => {},
    );
  });

  test("step.waitForEvent", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction({ id: "fn", triggers: [et] }, async ({ step }) => {
      const matched = await step.waitForEvent("id", {
        event: et,
        timeout: 1000,
      });
      expectTypeOf(matched).not.toBeAny();
      expectTypeOf(matched).toEqualTypeOf<{
        name: "event-1";
        data: { msg: string };
        id: string;
        ts: number;
        v?: string;
      } | null>();
    });
  });

  test("multiple event types", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      {
        id: "fn",
        triggers: [
          eventType("event-1", { schema: z.object({ a: z.string() }) }),
          eventType("event-2", { schema: z.object({ b: z.number() }) }),
        ],
      },
      ({ event }) => {
        expectTypeOf(event.name).not.toBeAny();
        expectTypeOf(event.name).toEqualTypeOf<
          "event-1" | "event-2" | "inngest/function.invoked"
        >();

        expectTypeOf(event.data).not.toBeAny();
        expectTypeOf(event.data).toEqualTypeOf<{ a: string } | { b: number }>();

        expectTypeOf(event.data).not.toBeAny();
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

  test("same event name different schemas", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      {
        id: "fn",
        triggers: [
          eventType("event-1", { schema: z.object({ a: z.string() }) }),
          eventType("event-1", { schema: z.object({ b: z.number() }) }),
        ],
      },
      ({ event }) => {
        expectTypeOf(event.name).not.toBeAny()
        expectTypeOf(event.name).toEqualTypeOf<
          "event-1" | "inngest/function.invoked"
        >();

        expectTypeOf(event.data).not.toBeAny();
        expectTypeOf(event.data).toEqualTypeOf<{ a: string } | { b: number }>();
      },
    );
  });

  test("wildcard", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      {
        id: "fn",
        triggers: [
          eventType("event-1", { schema: z.object({ a: z.string() }) }),
          eventType("user/*", { schema: z.object({ b: z.string() }) }),
        ],
      },
      ({ event }) => {
        expectTypeOf(event.name).not.toBeAny();

        // TODO: Improve this. It'd be awesome to properly support wildcards,
        // instead of throwing up our hands and using "unknown"
        expectTypeOf(event.name).toBeUnknown();

        expectTypeOf(event.data).not.toBeAny();
        expectTypeOf(event.data).toEqualTypeOf<{ a: string } | { b: string }>();
      },
    );
  });

  test("schema isn't an object", () => {
    eventType("evt", {
      // @ts-expect-error - Schema must be an object
      schema: z.string(),
    });

    eventType("evt", {
      // @ts-expect-error - Schema must be an object
      schema: z.array(z.object({ a: z.string() })),
    });
  });
});

test("eventType with version", () => {
  // Can set the event type version
  const et = eventType("event-1", { version: "1.0.0" });
  expect(et.version).toBe("1.0.0");
  expectTypeOf(et.version).not.toBeAny();
  expectTypeOf(et.version).toEqualTypeOf<string | undefined>();

  // Defaults to event type version
  const created = et.create();
  expect(created.v).toBe("1.0.0");
  expectTypeOf(created.v).not.toBeAny();
  expectTypeOf(created.v).toEqualTypeOf<string | undefined>();

  // Can override the version
  const createdWithVersion = et.create({}, { v: "2.0.0" });
  expect(createdWithVersion.v).toBe("2.0.0");
  expectTypeOf(createdWithVersion.v).not.toBeAny();
  expectTypeOf(createdWithVersion.v).toEqualTypeOf<string | undefined>();
});

describe("invoke", () => {
  test("return", () => {
    const inv = invoke(z.object({ message: z.string() }));
    expect(inv.event).toBe("inngest/function.invoked");
    expectTypeOf(inv.event).not.toBeAny();
    expectTypeOf(inv.event).toEqualTypeOf<"inngest/function.invoked">();

    expect(inv.schema).toBeDefined();
    expectTypeOf(inv.schema).not.toBeAny();
    expectTypeOf(inv.schema).toEqualTypeOf<
      StandardSchemaV1<{ message: string }>
    >();
  });

  test("createFunction", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      { id: "fn", triggers: [invoke(z.object({ msg: z.string() }))] },
      ({ event }) => {
        expectTypeOf(event.name).not.toBeAny();
        expectTypeOf(event.name).toEqualTypeOf<"inngest/function.invoked">();

        expectTypeOf(event.data).not.toBeAny();
        expectTypeOf(event.data).toEqualTypeOf<{ msg: string }>();
      },
    );
  });

  test("step.invoke", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction({ id: "parent", triggers: [] }, async ({ step }) => {
      await step.invoke("invoke", {
        function: child,
        data: { msg: "hello" },
      });

      await step.invoke("invoke", {
        function: child,

        // @ts-expect-error - Invalid data
        data: { wrong: "data" },
      });

      // @ts-expect-error - Missing data
      await step.invoke("invoke", {
        function: child,
      });
    });

    const child = inngest.createFunction(
      { id: "child", triggers: [invoke(z.object({ msg: z.string() }))] },
      () => {},
    );
  });

  test("invoke event not in triggers config is ignored", () => {
    const inngest = new Inngest({ id: "app" });
    const fn = inngest.createFunction(
      { id: "fn", triggers: [invoke(z.object({ msg: z.string() }))] },
      () => {},
    );
    const config = fn["getConfig"]({
      baseUrl: new URL("http://localhost:3000"),
      appPrefix: "app",
    });
    expect(config).toHaveLength(1);
    expect(config[0]!.triggers).toEqual([]);
  });
});

describe("mixed triggers", () => {
  test("multiple of each kind", () => {
    const inngest = new Inngest({ id: "app" });
    const fn = inngest.createFunction(
      {
        id: "fn",
        triggers: [
          eventType("event-1", { schema: z.object({ a: z.string() }) }),
          cron("* * * * *"),
          invoke(z.object({ name: z.string() })),
          eventType("event-2", { schema: z.object({ b: z.number() }) }),
          cron("0 0 * * *"),
          invoke(z.object({ age: z.number() })),
        ],
      },
      ({ event }) => {
        expectTypeOf(event.name).not.toBeAny();
        expectTypeOf(event.name).toEqualTypeOf<
          | "event-1"
          | "event-2"
          | "inngest/scheduled.timer"
          | "inngest/function.invoked"
        >();

        expectTypeOf(event.data).not.toBeAny();
        expectTypeOf(event.data).toEqualTypeOf<
          | { a: string }
          | { b: number }
          | { name: string }
          | { age: number }
          | { cron: string }
        >();

        // Can type narrow the data type based on the event name
        if (event.name === "event-1") {
          expectTypeOf(event.data).toEqualTypeOf<{ a: string }>();
        } else if (event.name === "event-2") {
          expectTypeOf(event.data).toEqualTypeOf<{ b: number }>();
        } else if (event.name === "inngest/scheduled.timer") {
          expectTypeOf(event.data).toEqualTypeOf<{ cron: string }>();
        } else if (event.name === "inngest/function.invoked") {
          expectTypeOf(event.data).toEqualTypeOf<
            { name: string } | { age: number }
          >();
        }
      },
    );

    inngest.createFunction({ id: "fn", triggers: [] }, async ({ step }) => {
      await step.invoke("invoke", {
        function: fn,

        // @ts-expect-error - Can't invoke using event schema
        data: { a: "hello" },
      });

      // @ts-expect-error - Missing data
      await step.invoke("invoke", {
        function: fn,
      });

      await step.invoke("invoke", {
        function: fn,
        data: { name: "Alice" },
      });

      await step.invoke("invoke", {
        function: fn,
        data: { age: 10 },
      });
    });
  });

  test("object literals instead of trigger creation functions", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      {
        id: "fn",
        triggers: [
          { event: "event-1", schema: z.object({ a: z.string() }) },
          { cron: "0 0 * * *" },
        ],
      },
      ({ event }) => {
        expectTypeOf(event.name).toEqualTypeOf<
          "event-1" | "inngest/scheduled.timer" | "inngest/function.invoked"
        >();
        expectTypeOf(event.data).not.toBeAny();
        expectTypeOf(event.data).toEqualTypeOf<
          { a: string } | { cron: string }
        >();

        // Can type narrow the data type based on the event name
        if (event.name === "event-1") {
          expectTypeOf(event.data).toEqualTypeOf<{ a: string }>();
        } else if (event.name === "inngest/scheduled.timer") {
          expectTypeOf(event.data).toEqualTypeOf<{ cron: string }>();
        } else if (event.name === "inngest/function.invoked") {
          expectTypeOf(event.data).toEqualTypeOf<{ a: string }>();
        }
      },
    );
  });

  test("event type and invoke", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      {
        id: "fn",
        triggers: [
          eventType("event-1", { schema: z.object({ a: z.string() }) }),
          invoke(z.object({ b: z.number() })),
        ],
      },
      ({ event }) => {
        expectTypeOf(event.name).not.toBeAny();
        expectTypeOf(event.name).toEqualTypeOf<
          "event-1" | "inngest/function.invoked"
        >();

        expectTypeOf(event.data).not.toBeAny();
        expectTypeOf(event.data).toEqualTypeOf<{ a: string } | { b: number }>();

        if (event.name === "event-1") {
          expectTypeOf(event.data).toEqualTypeOf<{ a: string }>();
        } else if (event.name === "inngest/function.invoked") {
          expectTypeOf(event.data).toEqualTypeOf<{ b: number }>();
        }
      },
    );
  });

  test("wildcard event type and invoke", () => {
    const inngest = new Inngest({ id: "app" });
    inngest.createFunction(
      {
        id: "fn",
        triggers: [
          eventType("user/*", {
            schema: z.object({ type: z.literal("user") }),
          }),
          eventType("admin/*", {
            schema: z.object({ type: z.literal("admin") }),
          }),
          invoke(z.object({ type: z.literal("invoke") })),
        ],
      },
      ({ event }) => {
        expectTypeOf(event.name).not.toBeAny();
        expectTypeOf(event.name).toEqualTypeOf<
          unknown | "inngest/function.invoked"
        >();

        expectTypeOf(event.data).not.toBeAny();
        expectTypeOf(event.data).toEqualTypeOf<
          { type: "user" } | { type: "admin" } | { type: "invoke" }
        >();
      },
    );
  });
});
