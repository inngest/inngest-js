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
