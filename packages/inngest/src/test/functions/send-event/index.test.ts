import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod/v3";
import { eventType, Inngest } from "../../../index";
import {
  checkIntrospection,
  eventRunWithName,
  receivedEventWithName,
  sendEvent,
} from "../../helpers";

checkIntrospection({
  name: "send-event",
  triggers: [{ event: "demo/send.event" }],
});

describe("run", () => {
  let eventId: string;
  let runId: string;

  beforeAll(async () => {
    eventId = await sendEvent("demo/send.event");
  });

  test("runs in response to 'demo/send.event'", async () => {
    runId = await eventRunWithName(eventId, "send-event");
    expect(runId).toEqual(expect.any(String));
  }, 60000);

  test("sent event 'app/my.event.happened'", async () => {
    const event = await receivedEventWithName("app/my.event.happened");
    expect(event).toBeDefined();
    expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({ foo: "bar" });
  }, 60000);

  test("sent event 'app/my.event.happened.multiple.1'", async () => {
    const event = await receivedEventWithName(
      "app/my.event.happened.multiple.1",
    );
    expect(event).toBeDefined();
    expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({ foo: "bar" });
  }, 60000);

  test("sent event 'app/my.event.happened.multiple.2'", async () => {
    const event = await receivedEventWithName(
      "app/my.event.happened.multiple.2",
    );
    expect(event).toBeDefined();
    expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({ foo: "bar" });
  }, 60000);
});

describe("payload validation", () => {
  const inngest = new Inngest({
    id: "app",
    isDev: true,
  });

  test("valid data", async () => {
    const eventName = `${Math.floor(Math.random() * 10_000_000)}`;
    const et = eventType(eventName, {
      schema: z.object({
        valid: z.literal(true),
      }),
    });

    const {ids} = await inngest.send(et.create({ data: { valid: true } }));
    expect(ids).toEqual(expect.any(Array));
  });

  test("invalid data", async () => {
    const eventName = `${Math.floor(Math.random() * 10_000_000)}`;
    const et = eventType(eventName, {
      schema: z.object({
        valid: z.literal(true),
      }),
    });

    await expect(
      inngest.send(
        et.create({
          data: {
            // @ts-expect-error - Invalid data
            valid: false,
          },
        }),
      ),
    ).rejects.toThrowError("Invalid literal value, expected true");
  });

  test("no schema", async () => {
    const eventName = `${Math.floor(Math.random() * 10_000_000)}`;
    const et = eventType(eventName);

    const {ids} = await inngest.send(et.create({ data: {} }));
    expect(ids).toEqual(expect.any(Array));
  });
});
