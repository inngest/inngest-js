import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { z } from "zod/v3";
import { eventType, Inngest, invoke, Middleware } from "../../../../index.ts";
import type { Jsonify } from "../../../../types.ts";
import { BaseSerializerMiddleware, fetchEvent, isRecord } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

describe("client level", () => {
  test("step.run", async () => {
    // Return a Date object from a step and expect the Date object to exist in the
    // step output

    const state = createState({
      stepOutputs: [] as { date: Date; int: number }[],
    });

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [DateSerializerMiddleware],
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
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.stepOutputs).toEqual([
      { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 },
    ]);
  });

  test("event.data", async () => {
    // Send an event with a Date object and expect the Date object to exist in the
    // event data

    const state = createState({
      eventData: null as { date: Date; int: number } | null,
      eventsData: [] as { date: Date; int: number }[],
    });

    const et = eventType(randomSuffix("evt"), {
      schema: z.object({
        date: z.date(),
        int: z.number(),
      }),
    });
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [DateSerializerMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [et] },
      async ({ event, events, runId }) => {
        state.runId = runId;
        expectTypeOf(event.data).not.toBeAny();
        state.eventData = event.data;
        state.eventsData = events.map((event) => {
          expectTypeOf(event.data).not.toBeAny();
          return event.data;
        });
      },
    );
    await createTestApp({ client, functions: [fn] });

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
    // Invoke a function with a Date object and expect the Date object to exist in
    // the child function's event data and the parent function's `step.invoke`
    // output. In other words, a Date object flows through:
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
      middleware: [DateSerializerMiddleware],
    });
    const parentFn = client.createFunction(
      { id: "parent-fn", retries: 0, triggers: [{ event: eventName }] },
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
        triggers: [invoke(z.object({ date: z.date(), int: z.number() }))],
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
    await createTestApp({ client, functions: [parentFn, childFn] });

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
    // Return a Date object from a step and expect the Date object to exist in the
    // step output

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
        middleware: [DateSerializerMiddleware],
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
    await createTestApp({ client, functions: [fn] });

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
      schema: z.object({
        date: z.date(),
        int: z.number(),
      }),
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
        middleware: [DateSerializerMiddleware],
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
        middleware: [DateSerializerMiddleware],
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
    await createTestApp({ client, functions: [fnParent, fnChild] });

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
    // Invoke a function with a Date object and expect the Date object to exist in
    // the child function's event data and the parent function's `step.invoke`
    // output. In other words, a Date object flows through:
    // Client send -> Parent fn -> Child fn -> Parent fn

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
        middleware: [DateSerializerMiddleware],
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
        middleware: [DateSerializerMiddleware],
        triggers: [invoke(z.object({ date: z.date(), int: z.number() }))],
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
    await createTestApp({ client, functions: [parentFn, childFn] });

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

test("with checkpointing", async () => {
  // Serialization and deserialization works with checkpointing.
  // `wrapStepHandler` handles serialization (server-bound data) and
  // `wrapStep` handles deserialization (user-bound data). With the new
  // design, wrapStep fires only once per step per request.

  const state = createState({
    stepOutputs: [] as Date[],
    wrapStepCalls: [] as { id: string; memoized: boolean; output: unknown }[],
  });

  class MW extends DateSerializerMiddleware {
    override async wrapStep(args: Middleware.WrapStepArgs) {
      const output = await super.wrapStep(args);
      state.wrapStepCalls.push({
        id: args.stepInfo.options.id,
        memoized: args.stepInfo.memoized,
        output,
      });
      return output;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing: true,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      const output = await step.run("my-step", () => {
        return new Date("2026-02-03T00:00:00.000Z");
      });
      expectTypeOf(output).not.toBeAny();
      expectTypeOf(output).toEqualTypeOf<Date>();
      state.stepOutputs.push(output);

      // Sleep to ensure we reenter the function
      await step.sleep("zzz", "1s");
    },
  );
  await createTestApp({ client, functions: [fn] });
  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Always deserialized within the function handler
  expect(state.stepOutputs).toEqual([
    new Date("2026-02-03T00:00:00.000Z"),
    new Date("2026-02-03T00:00:00.000Z"),
  ]);
  expect(state.wrapStepCalls).toEqual([
    // --- Request 1: execute `step.run` and then plan `step.sleep` ---
    // wrapStep fires once; wrapStepHandler serialized for server,
    // wrapStep deserializes for the user function
    {
      id: "my-step",
      memoized: false,
      output: new Date("2026-02-03T00:00:00.000Z"),
    },

    // --- Request 2: wake `step.sleep` ---
    {
      id: "my-step",
      memoized: true,
      output: new Date("2026-02-03T00:00:00.000Z"),
    },
    { id: "zzz", memoized: true, output: null },
  ]);
});

describe("outgoing event data is serialized", () => {
  test("client.send", async () => {
    // When sending an event via the client, event data is serialized before
    // sending to the Inngest Server. But within the triggered Inngest function,
    // the event data is deserialized.

    const state = createState({
      event: null as { data: { date: Date; int: number } } | null,
    });

    const sentEventName = randomSuffix("evt-sent");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [DateSerializerMiddleware],
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: eventType(sentEventName, {
          schema: z.object({ date: z.date(), int: z.number() }),
        }),
      },
      async ({ event, runId }) => {
        state.runId = runId;
        expectTypeOf(event.data).not.toBeAny();
        state.event = event;
      },
    );
    await createTestApp({ client, functions: [fn] });

    const { ids } = await client.send({
      data: { date: new Date("2026-02-03T00:00:00.000Z"), int: 42 },
      name: sentEventName,
    });
    await state.waitForRunComplete();

    // Serialized on the Dev Server
    const eventFromDevServer = await fetchEvent(ids[0]!);
    expect(eventFromDevServer.data).toEqual({
      date: {
        [serializedMarker]: true,
        value: "2026-02-03T00:00:00.000Z",
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
    // before sending to the Inngest Server. But within the triggered Inngest
    // function, the event data is deserialized.

    const state = createState({
      childEvent: null as { data: { date: Date; int: number } } | null,
      childEventId: null as string | null,
    });

    const parentEventName = randomSuffix("evt");
    const childEventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [DateSerializerMiddleware],
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
          schema: z.object({ date: z.date(), int: z.number() }),
        }),
      },
      async ({ event, runId }) => {
        state.runId = runId;
        expectTypeOf(event.data).not.toBeAny();
        state.childEvent = event;
      },
    );
    await createTestApp({ client, functions: [fn, childFn] });

    await client.send({ name: parentEventName });
    await state.waitForRunComplete();

    // Serialized on the Dev Server
    const eventFromDevServer = await fetchEvent(state.childEventId!);
    expect(eventFromDevServer.data).toEqual({
      date: {
        [serializedMarker]: true,
        value: "2026-02-03T00:00:00.000Z",
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

// Normal TypeScript type that preserves Date objects, else jsonifies
type PreservedDate<T> = T extends Date
  ? Date
  : T extends Array<infer U>
    ? Array<PreservedDate<U>>
    : T extends Record<string, unknown>
      ? { [K in keyof T]: PreservedDate<T[K]> }
      : Jsonify<T>;

// Higher-kinded type that preserves Date objects, else jsonifies
interface PreserveDate extends Middleware.StaticTransform {
  Out: PreservedDate<this["In"]>;
}

// How Date objects are represented after serialization
const serializedMarker = "__INNGEST_DATE_SERIALIZER__";
type Serialized = {
  [serializedMarker]: true;
  value: string;
};

class DateSerializerMiddleware extends BaseSerializerMiddleware<Serialized> {
  readonly id = "test:date-serializer";
  declare functionOutputTransform: PreserveDate;
  declare stepOutputTransform: PreserveDate;

  protected deserialize(value: Serialized): unknown {
    return new Date(value.value);
  }

  protected isSerialized(value: unknown): value is Serialized {
    if (!isRecord(value)) {
      return false;
    }
    return Object.hasOwn(value, serializedMarker);
  }

  protected needsSerialize(value: unknown): boolean {
    return value instanceof Date;
  }

  protected serialize(value: unknown): Serialized {
    if (value instanceof Date) {
      return {
        [serializedMarker]: true,
        value: value.toISOString(),
      };
    }
    return value as Serialized;
  }
}
