import { describe, expect, test } from "vitest";
import { z } from "zod/v3";
import { internalEvents } from "../../helpers/consts";
import { cron, eventType, invoke } from "./triggers";
import { validateEvents } from "./utils";

test("literal object", async () => {
  // No validation is performed

  const events = [{ name: "evt", data: { valid: false } }] as const;
  const triggers = [{ event: "evt" }] as const;

  expect(await validateEvents(events, triggers)).toEqual(events);
});

describe("eventType: success", async () => {
  test("basic", async () => {
    const events = [{ name: "evt", data: { valid: true } }] as const;
    const triggers = [
      eventType("evt", { schema: z.object({ valid: z.literal(true) }) }),
    ] as const;

    await expect(validateEvents(events, triggers)).resolves.toBe(events);
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

    expect(await validateEvents(events, triggers)).toEqual(events);
  });

  test("no schema", async () => {
    // No validation is performed

    const events = [{ name: "evt", data: { valid: false } }] as const;
    const triggers = [eventType("evt")] as const;

    expect(await validateEvents(events, triggers)).toEqual(events);
  });
});

describe("eventType: failure", async () => {
  test("basic", async () => {
    const events = [{ name: "evt", data: { valid: false } }] as const;
    const triggers = [
      eventType("evt", { schema: z.object({ valid: z.literal(true) }) }),
    ] as const;

    await expect(validateEvents(events, triggers)).rejects.toThrowError(
      expect.objectContaining({
        message: "Invalid literal value, expected true",
      }),
    );
  });

  test("2nd event fails both schemas", async () => {
    const events = [
      { name: "evt-2", data: { valid: true } },
      { name: "evt-2", data: { valid: false } },
    ] as const;
    const triggers = [
      eventType("evt-1", { schema: z.object({ msg: z.string() }) }),
      eventType("evt-2", { schema: z.object({ valid: z.literal(true) }) }),
    ] as const;

    await expect(validateEvents(events, triggers)).rejects.toThrowError(
      expect.objectContaining({
        message: "Invalid literal value, expected true",
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
});

describe("cron", async () => {
  test("cron", async () => {
    const events = [{ name: internalEvents.ScheduledTimer, data: {} }] as const;
    const triggers = [cron("0 0 * * *")] as const;

    expect(await validateEvents(events, triggers)).toEqual(events);
  });
});

describe("invoke: success", async () => {
  test("basic", async () => {
    const events = [
      { name: internalEvents.FunctionInvoked, data: { valid: true } },
    ] as const;
    const triggers = [invoke(z.object({ valid: z.literal(true) }))] as const;

    expect(await validateEvents(events, triggers)).toEqual(events);
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

    expect(await validateEvents(events, triggers)).toEqual(events);
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

    expect(await validateEvents(events, triggers)).toEqual(events);
  });
});

describe("invoke: failure", async () => {
  test("basic", async () => {
    const events = [
      { name: internalEvents.FunctionInvoked, data: { valid: false } },
    ] as const;
    const triggers = [invoke(z.object({ valid: z.literal(true) }))] as const;

    await expect(validateEvents(events, triggers)).rejects.toThrowError(
      expect.objectContaining({
        message: "Invalid literal value, expected true",
      }),
    );
  });

  test("only event type trigger", async () => {
    // When there is only an event type trigger, validate the invoke event
    // against it

    const events = [
      { name: internalEvents.FunctionInvoked, data: { valid: false } },
    ] as const;
    const triggers = [
      eventType("evt", { schema: z.object({ valid: z.literal(true) }) }),
    ] as const;

    await expect(validateEvents(events, triggers)).rejects.toThrowError(
      expect.objectContaining({
        message: "Invalid literal value, expected true",
      }),
    );
  });
});
