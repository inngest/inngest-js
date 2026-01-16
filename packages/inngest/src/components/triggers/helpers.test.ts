import { describe, test } from "vitest";
import { z } from "zod";
import type { ReceivedEvent, ToReceivedEvent } from "./helpers.ts";
import { cron, eventType, invoke } from "./triggers.ts";

describe("ToReceivedEvent", () => {
  test("single event", () => {
    const triggers = [
      eventType("event-1", { schema: z.object({ a: z.string() }) }),
    ] as const;

    type ReceivedEvents = ToReceivedEvent<typeof triggers>;
    expectTypeOf<ReceivedEvents>().not.toBeAny();
    expectTypeOf<ReceivedEvents>().toExtend<
      [
        ReceivedEvent<"event-1", { a: string }>,
        ReceivedEvent<"inngest/function.invoked", { a: string }>,
      ]
    >();
  });

  test("single cron trigger", () => {
    const triggers = [cron("* * * * *")] as const;

    type ReceivedEvents = ToReceivedEvent<typeof triggers>;
    expectTypeOf<ReceivedEvents>().not.toBeAny();
    expectTypeOf<ReceivedEvents>().toExtend<
      [
        ReceivedEvent<"inngest/scheduled.timer", {}>,
        ReceivedEvent<"inngest/function.invoked", {}>,
      ]
    >();
  });

  test("multiple cron triggers", () => {
    // Multiple cron triggers are merged

    const triggers = [cron("* * * * *"), cron("0 0 * * *")] as const;

    type ReceivedEvents = ToReceivedEvent<typeof triggers>;
    expectTypeOf<ReceivedEvents>().not.toBeAny();
    expectTypeOf<ReceivedEvents>().toExtend<
      [
        ReceivedEvent<"inngest/scheduled.timer", {}>,
        ReceivedEvent<"inngest/function.invoked", {}>,
      ]
    >();
  });

  test("multiple event and cron triggers", () => {
    const triggers = [
      eventType("event-1", { schema: z.object({ a: z.string() }) }),
      cron("* * * * *"),
      cron("0 0 * * *"),
      eventType("event-2", { schema: z.object({ b: z.number() }) }),
    ] as const;

    type ReceivedEvents = ToReceivedEvent<typeof triggers>;
    expectTypeOf<ReceivedEvents>().not.toBeAny();
    expectTypeOf<ReceivedEvents>().toExtend<
      [
        ReceivedEvent<"event-1", { a: string }>,
        ReceivedEvent<"inngest/scheduled.timer", {}>,
        ReceivedEvent<"event-2", { b: number }>,
        ReceivedEvent<
          "inngest/function.invoked",
          { a: string } | { b: number }
        >,
      ]
    >();
  });

  test("single invoke trigger", () => {
    const triggers = [invoke(z.object({ a: z.string() }))] as const;

    type ReceivedEvents = ToReceivedEvent<typeof triggers>;
    expectTypeOf<ReceivedEvents>().not.toBeAny();
    expectTypeOf<ReceivedEvents>().toEqualTypeOf<
      [ReceivedEvent<"inngest/function.invoked", { a: string }>]
    >();
  });

  test("multiple invoke triggers", () => {
    // Multiple invoke triggers are merged

    const triggers = [
      invoke(z.object({ a: z.string() })),
      invoke(z.object({ b: z.number() })),
    ] as const;

    type ReceivedEvents = ToReceivedEvent<typeof triggers>;
    expectTypeOf<ReceivedEvents>().not.toBeAny();
    expectTypeOf<ReceivedEvents>().toEqualTypeOf<
      [ReceivedEvent<"inngest/function.invoked", { a: string } | { b: number }>]
    >();
  });

  test("with condition", () => {
    const triggers = [
      {
        event: eventType("event-1", { schema: z.object({ a: z.string() }) }),
        if: "event.data.a == 'bar'",
      },
    ] as const;

    type ReceivedEvents = ToReceivedEvent<typeof triggers>;
    expectTypeOf<ReceivedEvents>().not.toBeAny();
    expectTypeOf<ReceivedEvents>().toExtend<
      [
        ReceivedEvent<"event-1", { a: string }>,
        ReceivedEvent<"inngest/function.invoked", { a: string }>,
      ]
    >();
  });
});
