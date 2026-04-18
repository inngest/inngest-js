import {
  createState,
  createTestApp,
  DEV_SERVER_URL,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import {
  eventType,
  Inngest,
  invoke,
  staticSchema,
} from "inngest";
import { createServer } from "inngest/node";
import { describe, expect, expectTypeOf, test } from "vitest";
import { isRecord, SuperJsonMiddleware } from "../../index";

const testFileName = testNameFromFileUrl(import.meta.url);

describe("client level", () => {
  test("step.run", async () => {
    // Return a Date object from a step and expect the Date object to exist in
    // the step output

    const state = createState({
      stepOutputs: [] as { date: Date; int: number }[],
    });

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [SuperJsonMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        state.runId = runId;
        const output = await step.run("my-step", () => {
          return { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 };
        });
        expectTypeOf(output).not.toBeAny();
        expectTypeOf(output).toEqualTypeOf<{ date: Date; int: number }>();
        state.stepOutputs.push(output);
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.stepOutputs).toEqual([
      { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 },
    ]);
  });

  test("event.data", async () => {
    // Send an event with a Date object and expect the Date object to exist in
    // the event data

    const state = createState({
      eventData: null as { date: Date; int: number } | null,
      eventsData: [] as { date: Date; int: number }[],
    });

    const et = eventType(randomSuffix("evt"), {
      schema: staticSchema<{ date: Date; int: number }>(),
    });
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [SuperJsonMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [et] },
      async ({ event, events, runId }) => {
        state.runId = runId;
        expectTypeOf(event.data).not.toBeAny();
        expectTypeOf(event.data).toEqualTypeOf<{ date: Date; int: number }>();
        state.eventData = event.data;
        state.eventsData = events.map((event) => {
          expectTypeOf(event.data).not.toBeAny();
          return event.data;
        });
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send(
      et.create({
        date: new Date("2026-02-03T00:00:00.000Z"),
        int: 42,
      }),
    );
    await state.waitForRunComplete();

    expect(state.eventsData).toEqual([
      { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 },
    ]);
    expect(state.eventData).toEqual({
      date: new Date("2026-02-03T00:00:00.000Z"),
      int: 42,
    });
  });

  test("step.invoke", async () => {
    // Invoke a function with a Date object and expect the Date object to exist
    // in the child function's event data and the parent function's
    // `step.invoke` output. In other words, a Date object flows through:
    // Parent fn -> Child fn -> Parent fn

    const state = createState({
      eventData: null as { date: Date; int: number } | null,
      eventsData: [] as { date: Date; int: number }[],
      stepOutputs: [] as { date: Date; int: number }[],
    });

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [SuperJsonMiddleware],
    });
    const parentFn = client.createFunction(
      { id: "parent-fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        state.runId = runId;
        console.log("a")
        const output = await step.invoke("a", {
          data: { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 },
          function: childFn,
        });
        console.log("b")
        expectTypeOf(output).not.toBeAny();
        expectTypeOf(output).toEqualTypeOf<{ date: Date; int: number }>();
        state.stepOutputs.push(output);
      },
    );
    const childFn = client.createFunction(
      {
        id: "child-fn",
        retries: 0,
        triggers: [invoke(staticSchema<{ date: Date; int: number }>())],
      },
      async ({ event, events }) => {
        console.log("c")
        expectTypeOf(event.data).not.toBeAny();
        state.eventData = event.data;
        state.eventsData = events.map((event) => {
          expectTypeOf(event.data).not.toBeAny();
          return event.data;
        });

        return event.data;
      },
    );
    await createTestApp({
      client,
      functions: [parentFn, childFn],
      serve: createServer,
    });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.eventsData).toEqual([
      {
        _inngest: expect.any(Object),
        date: new Date("2026-02-03T00:00:00.000Z"),
        int: 42,
      },
    ]);
    expect(state.eventData).toEqual({
      _inngest: expect.any(Object),
      date: new Date("2026-02-03T00:00:00.000Z"),
      int: 42,
    });
    expect(state.stepOutputs).toEqual([
      {
        _inngest: expect.any(Object),
        date: new Date("2026-02-03T00:00:00.000Z"),
        int: 42,
      },
    ]);
  });
});

describe("function level", () => {
  test("step.run", async () => {
    // Return a Date object from a step and expect the Date object to exist in
    // the step output

    const state = createState({
      stepOutputs: [] as { date: Date; int: number }[],
    });

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        middleware: [SuperJsonMiddleware],
        triggers: [{ event: eventName }],
      },
      async ({ step, runId }) => {
        state.runId = runId;
        const output = await step.run("my-step", () => {
          return { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 };
        });
        expectTypeOf(output).not.toBeAny();
        expectTypeOf(output).toEqualTypeOf<{ date: Date; int: number }>();
        state.stepOutputs.push(output);
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.stepOutputs).toEqual([
      { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 },
    ]);
  });

  test("event.data", async () => {
    // Send an event with a Date object via `step.sendEvent` and expect the Date
    // object to exist in the child function's event data. Function-level
    // middleware only fires for `step.sendEvent`, not `client.send`.

    const state = createState({
      childEventData: null as { date: Date; int: number } | null,
      childEventsData: [] as { date: Date; int: number }[],
    });

    const parentTrigger = randomSuffix("evt");
    const childTrigger = eventType(randomSuffix("evt"), {
      schema: staticSchema<{ date: Date; int: number }>(),
    });

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
    });

    // Parent function has the middleware and sends the serialized event
    const fnParent = client.createFunction(
      {
        id: "parent",
        retries: 0,
        middleware: [SuperJsonMiddleware],
        triggers: { event: parentTrigger },
      },
      async ({ step, runId }) => {
        state.runId = runId;
        await step.sendEvent("send-it", {
          name: childTrigger.name,
          data: { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 },
        });
      },
    );

    // Child function also has the middleware to deserialize event data
    const fnChild = client.createFunction(
      {
        id: "child",
        retries: 0,
        middleware: [SuperJsonMiddleware],
        triggers: childTrigger,
      },
      async ({ event, events }) => {
        expectTypeOf(event.data).not.toBeAny();
        state.childEventData = event.data;
        state.childEventsData = events.map((event) => {
          return event.data as { date: Date; int: number };
        });
      },
    );
    await createTestApp({
      client,
      functions: [fnParent, fnChild],
      serve: createServer,
    });

    await client.send({ name: parentTrigger });
    await state.waitForRunComplete();
    await waitFor(() => {
      expect(state.childEventData).not.toBeNull();
    });

    expect(state.childEventsData).toEqual([
      { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 },
    ]);
    expect(state.childEventData).toEqual({
      date: new Date("2026-02-03T00:00:00.000Z"),
      int: 42,
    });
  });

  test("step.invoke", async () => {
    // Invoke a function with a Date object and expect the Date object to exist
    // in the child function's event data and the parent function's
    // `step.invoke` output.

    const state = createState({
      eventData: null as { date: Date; int: number } | null,
      eventsData: [] as { date: Date; int: number }[],
      stepOutputs: [] as { date: Date; int: number }[],
    });

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
    });
    const parentFn = client.createFunction(
      {
        id: "parent-fn",
        retries: 0,
        middleware: [SuperJsonMiddleware],
        triggers: [{ event: eventName }],
      },
      async ({ step, runId }) => {
        state.runId = runId;
        const output = await step.invoke("a", {
          data: { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 },
          function: childFn,
        });
        expectTypeOf(output).not.toBeAny();
        expectTypeOf(output).toEqualTypeOf<{ date: Date; int: number }>();
        state.stepOutputs.push(output);
      },
    );
    const childFn = client.createFunction(
      {
        id: "child-fn",
        retries: 0,
        middleware: [SuperJsonMiddleware],
        triggers: [invoke(staticSchema<{ date: Date; int: number }>())],
      },
      async ({ event, events }) => {
        expectTypeOf(event.data).not.toBeAny();
        state.eventData = event.data;
        state.eventsData = events.map((event) => {
          expectTypeOf(event.data).not.toBeAny();
          return event.data;
        });

        return event.data;
      },
    );
    await createTestApp({
      client,
      functions: [parentFn, childFn],
      serve: createServer,
    });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.eventsData).toEqual([
      {
        _inngest: expect.any(Object),
        date: new Date("2026-02-03T00:00:00.000Z"),
        int: 42,
      },
    ]);
    expect(state.eventData).toEqual({
      _inngest: expect.any(Object),
      date: new Date("2026-02-03T00:00:00.000Z"),
      int: 42,
    });
    expect(state.stepOutputs).toEqual([
      {
        _inngest: expect.any(Object),
        date: new Date("2026-02-03T00:00:00.000Z"),
        int: 42,
      },
    ]);
  });
});


describe("outgoing event data is serialized", () => {
  test("client.send", async () => {
    // When sending an event via the client, event data is serialized into the
    // superjson envelope before sending to the Inngest Server. Within the
    // triggered function, the event data is deserialized back into a Date.

    const state = createState({
      event: null as { data: { date: Date; int: number } } | null,
    });

    const sentEventName = randomSuffix("evt-sent");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [SuperJsonMiddleware],
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: eventType(sentEventName, {
          schema: staticSchema<{ date: Date; int: number }>(),
        }),
      },
      async ({ event, runId }) => {
        state.runId = runId;
        expectTypeOf(event.data).not.toBeAny();
        state.event = event;
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    const { ids } = await client.send({
      data: { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 },
      name: sentEventName,
    });
    await state.waitForRunComplete();

    // Serialized on the Dev Server as a superjson envelope
    const eventFromDevServer = await fetchEvent(ids[0]!);
    expect(eventFromDevServer.data).toEqual({
      date: {
        __inngestSuperJson: true,
        json: "2026-02-03T00:00:00.000Z",
        meta: { v: 1, values: ["Date"] },
      },
      int: 42,
    });

    // Deserialized within the function handler
    expect(state.event?.data).toEqual({
      date: new Date("2026-02-03T00:00:00.000Z"),
      int: 42,
    });
  });

  test("step.sendEvent", async () => {
    // When sending an event via `step.sendEvent`, event data is serialized
    // before sending to the Inngest Server. Within the triggered function,
    // the event data is deserialized back into a Date.

    const state = createState({
      childEvent: null as { data: { date: Date; int: number } } | null,
      childEventId: null as string | null,
    });

    const parentEventName = randomSuffix("evt");
    const childEventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [SuperJsonMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: parentEventName }] },
      async ({ step, runId }) => {
        state.runId = runId;
        const { ids } = await step.sendEvent("send-it", {
          name: childEventName,
          data: { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 },
        });
        state.childEventId = ids[0]!;
      },
    );
    const childFn = client.createFunction(
      {
        id: "child-fn",
        retries: 0,
        triggers: eventType(childEventName, {
          schema: staticSchema<{ date: Date; int: number }>(),
        }),
      },
      async ({ event, runId }) => {
        state.runId = runId;
        expectTypeOf(event.data).not.toBeAny();
        state.childEvent = event;
      },
    );
    await createTestApp({
      client,
      functions: [fn, childFn],
      serve: createServer,
    });

    await client.send({ name: parentEventName });
    await state.waitForRunComplete();

    // Serialized on the Dev Server as a superjson envelope
    const eventFromDevServer = await fetchEvent(state.childEventId!);
    expect(eventFromDevServer.data).toEqual({
      date: {
        __inngestSuperJson: true,
        json: "2026-02-03T00:00:00.000Z",
        meta: { v: 1, values: ["Date"] },
      },
      int: 42,
    });

    // Deserialized within the function handler
    expect(state.childEvent?.data).toEqual({
      date: new Date("2026-02-03T00:00:00.000Z"),
      int: 42,
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchEvent(
  id: string,
): Promise<{ data: Record<string, unknown>; name: string }> {
  return waitFor(async () => {
    const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query Event($id: ULID!) {
          eventV2(id: $id) {
            name
            raw
          }
        }`,
        variables: { id },
        operationName: "Event",
      }),
    });
    expect(res.ok).toBe(true);

    const raw = (await res.json()) as {
      data: { eventV2: { name: string; raw: string } };
    };
    const parsed = raw.data.eventV2;
    const data = JSON.parse(parsed.raw).data;
    if (!isRecord(data)) {
      throw new Error("Event data is not a record");
    }
    return { data, name: parsed.name };
  });
}
