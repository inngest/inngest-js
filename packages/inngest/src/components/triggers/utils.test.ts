import { describe, expect, test } from "vitest";
import { z } from "zod/v3";
import { internalEvents } from "../../helpers/consts";
import { cron, eventType, invoke } from "./triggers";
import { validateEvents } from "./utils";

test("literal object", async () => {
  // No validation is performed

  const events = [{ name: "evt", data: { valid: false } }] as const;
  const triggers = [{ event: "evt" }] as const;

  await validateEvents(events, triggers);
});

describe("eventType: success", async () => {
  test("basic", async () => {
    const events = [{ name: "evt", data: { valid: true } }] as const;
    const triggers = [
      eventType("evt", { schema: z.object({ valid: z.literal(true) }) }),
    ] as const;

    await validateEvents(events, triggers);
  });

  test("multiple event types", async () => {
    const events = [
      { name: "evt-1", data: { valid: true } },
      { name: "evt-2", data: { valid: true } },
    ] as const;
    const triggers = [
      eventType("evt-1", { schema: z.object({ valid: z.literal(true) }) }),
      eventType("evt-2", { schema: z.object({ valid: z.literal(true) }) }),
    ] as const;

    await validateEvents(events, triggers);
  });

  test("no schema", async () => {
    // No validation is performed

    const events = [{ name: "evt", data: { valid: false } }] as const;
    const triggers = [eventType("evt")] as const;

    await validateEvents(events, triggers);
  });

  test("wildcard", async () => {
    const triggers = [
      eventType("user/*", { schema: z.object({ a: z.string() }) }),
      eventType("evt", { schema: z.object({ b: z.string() }) }),
    ] as const;

    // Valid against the wildcard trigger
    await validateEvents([{ name: "user/foo", data: { a: "A" } }], triggers);

    // Valid against the non-wildcard trigger
    await validateEvents([{ name: "evt", data: { b: "B" } }], triggers);
  });

  test("multiple matching wildcard triggers", async () => {
    const triggers = [
      eventType("user/*", { schema: z.object({ a: z.string() }) }),
      eventType("user/foo/*", { schema: z.object({ b: z.string() }) }),
    ] as const;

    // Valid against both wildcard triggers
    await validateEvents(
      [{ name: "user/foo/bar", data: { a: "A" } }],
      triggers,
    );
    await validateEvents(
      [{ name: "user/foo/bar", data: { b: "B" } }],
      triggers,
    );
  });
});

describe("eventType: failure", async () => {
  test("basic", async () => {
    const events = [{ name: "evt", data: { msg: 1 } }] as const;
    const triggers = [
      eventType("evt", { schema: z.object({ msg: z.string() }) }),
    ] as const;

    await expect(validateEvents(events, triggers)).rejects.toThrowError(
      expect.objectContaining({
        message: "msg: Expected string, received number",
      }),
    );
  });

  test("2nd event fails both schemas", async () => {
    const events = [
      { name: "evt-2", data: { name: "Alice" } },
      { name: "evt-2", data: { name: 1 } },
    ] as const;
    const triggers = [
      eventType("evt-1", { schema: z.object({ msg: z.string() }) }),
      eventType("evt-2", { schema: z.object({ name: z.string() }) }),
    ] as const;

    await expect(validateEvents(events, triggers)).rejects.toThrowError(
      expect.objectContaining({
        message: "name: Expected string, received number",
      }),
    );
  });

  test("unexpected event", async () => {
    const events = [{ name: "other", data: { valid: true } }] as const;
    const triggers = [
      eventType("evt", { schema: z.object({ valid: z.literal(true) }) }),
    ] as const;

    await expect(validateEvents(events, triggers)).rejects.toThrowError(
      expect.objectContaining({
        message: "Event not found in triggers: other",
      }),
    );
  });

  test("wildcard", async () => {
    const events = [
      { name: "user/foo", data: { msg: 1 } },
    ] as const;
    const triggers = [
      eventType("user/*", { schema: z.object({ msg: z.string() }) }),
    ] as const;
    await expect(validateEvents(events, triggers)).rejects.toThrowError(
      expect.objectContaining({
        message: "msg: Expected string, received number",
      }),
    );
  });
});

describe("cron", async () => {
  test("cron", async () => {
    const events = [{ name: internalEvents.ScheduledTimer, data: {} }] as const;
    const triggers = [cron("0 0 * * *")] as const;

    await validateEvents(events, triggers);
  });
});

describe("invoke: success", async () => {
  test("basic", async () => {
    const events = [
      { name: internalEvents.FunctionInvoked, data: { valid: true } },
    ] as const;
    const triggers = [invoke(z.object({ valid: z.literal(true) }))] as const;

    await validateEvents(events, triggers);
  });

  test("multiple invoke triggers", async () => {
    // When multiple invoke triggers are present, only one needs to match

    const events = [
      { name: internalEvents.FunctionInvoked, data: { a: "A" } },
      { name: internalEvents.FunctionInvoked, data: { b: "B" } },
    ] as const;
    const triggers = [
      invoke(z.object({ a: z.string() })),
      invoke(z.object({ b: z.string() })),
    ] as const;

    await validateEvents(events, triggers);
  });

  test("only event type trigger", async () => {
    // When there is only an event type trigger, validate the invoke event
    // against it

    const events = [
      { name: internalEvents.FunctionInvoked, data: { valid: true } },
    ] as const;
    const triggers = [
      eventType("evt", { schema: z.object({ valid: z.literal(true) }) }),
    ] as const;

    await validateEvents(events, triggers);
  });
});

describe("invoke: failure", async () => {
  test("basic", async () => {
    const events = [
      { name: internalEvents.FunctionInvoked, data: { msg: 1 } },
    ] as const;
    const triggers = [invoke(z.object({ msg: z.string() }))] as const;

    await expect(validateEvents(events, triggers)).rejects.toThrowError(
      expect.objectContaining({
        message: "msg: Expected string, received number",
      }),
    );
  });

  test("only event type trigger", async () => {
    // When there is only an event type trigger, validate the invoke event
    // against it

    const events = [
      { name: internalEvents.FunctionInvoked, data: { msg: 1 } },
    ] as const;
    const triggers = [
      eventType("evt", { schema: z.object({ msg: z.string() }) }),
    ] as const;

    await expect(validateEvents(events, triggers)).rejects.toThrowError(
      expect.objectContaining({
        message: "msg: Expected string, received number",
      }),
    );
  });
});
