import {
  createState,
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createDefer } from "../../../experimental.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import { spyLogger } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("schema validation succeeds", async () => {
  // When a deferred function specifies a schema, both the static and runtime
  // types conform to the schema

  const parentState = createState({});
  const deferState = createState({
    eventData: null as { msg: string } | null,
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(
    client,
    { id: "process", schema: z.object({ msg: z.string() }) },
    async ({ event, runId }) => {
      deferState.runId = runId;
      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data).toEqualTypeOf<{ msg: string }>();
      deferState.eventData = event.data;
    },
  );
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId, step }) => {
      parentState.runId = runId;
      const msg = await step.run("create-msg", () => {
        return "hello";
      });
      defer("foo", { function: foo, data: { msg } });

      // Assert that the static type is correct (we don't want `data` to be
      // `any`)
      expectTypeOf<
        Parameters<typeof defer<typeof foo>>[1]["data"]
      >().not.toBeAny();
      expectTypeOf<
        Parameters<typeof defer<typeof foo>>[1]["data"]
      >().toEqualTypeOf<{ msg: string }>();
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();
  expect(deferState.eventData).toEqual({ msg: "hello" });
});

test("re-encountered defer does not trigger new deferred run", async () => {
  // When a deferred function is re-encountered (e.g. function re-entry), it
  // should not trigger a new deferred run

  const parentState = createState({});
  const deferState = createState({ counter: 0 });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
    deferState.runId = runId;
    deferState.counter++;
  });
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId, step }) => {
      parentState.runId = runId;
      defer("foo", { function: foo, data: {} });

      // Force reentry so that the previous `defer` method runs again
      await step.sleep("sleep", "1s");
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();

  // Wait long enough to give the 2nd defer a chance to trigger (it shouldn't)
  await sleep(5000);

  expect(deferState.counter).toBe(1);
});

describe("schema validation fails in parent function", () => {
  // Schema failure at the call site is logged and the defer is skipped: the
  // parent run completes normally and the defer handler never fires.

  // A buggy or compromised StandardSchemaV1 validator that throws synchronously
  // must not escape `defer()` — fire-and-forget is the contract.
  const throwingSchema: StandardSchemaV1<Record<string, unknown>> = {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: () => {
        throw new Error("validator boom");
      },
    },
  };

  for (const c of [
    {
      name: "validator returns issues",
      schema: z.object({ msg: z.string() }),
      expectedLogPayload: {
        issues: expect.any(Array),
      },
      expectedLogMessage: "defer skipped: schema validation failed",
    },
    {
      name: "validator throws",
      schema: throwingSchema,
      expectedLogPayload: {},
      expectedLogMessage: expect.stringContaining("defer skipped"),
    },
  ]) {
    test(c.name, async () => {
      const state = createState({
        deferHandlerReached: false,
      });

      const internalLogger = spyLogger();
      const client = new Inngest({
        id: randomSuffix(testFileName),
        isDev: true,
        internalLogger,
      });
      const eventName = randomSuffix("evt");
      const foo = createDefer(
        client,
        { id: "foo", schema: c.schema },
        async () => {
          state.deferHandlerReached = true;
        },
      );
      const fn = client.createFunction(
        {
          id: "fn",
          retries: 0,
          triggers: { event: eventName },
        },
        async ({ defer, runId }) => {
          state.runId = runId;
          defer("foo", { function: foo, data: { msg: 123 } });
        },
      );
      await createTestApp({
        client,
        functions: [fn, foo],
        serve: createServer,
      });

      await client.send({ name: eventName, data: {} });
      await state.waitForRunComplete();

      // Wait long enough to give the defer handler a chance to run (it shouldn't)
      await sleep(2000);
      expect(state.deferHandlerReached).toBe(false);

      expect(internalLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: state.runId,
          ...c.expectedLogPayload,
        }),
        c.expectedLogMessage,
      );
    });
  }
});

test("schema validation fails within defer handler", async () => {
  // Send a date so that it passes validation in the main function, but fails
  // when running the defer handler (since the date becomes an ISO string).

  const state = createState({ deferHandlerReached: false });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(
    client,
    { id: "foo", schema: z.object({ date: z.date() }) },
    () => {
      state.deferHandlerReached = true;
    },
  );
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      state.runId = runId;
      defer("foo", { function: foo, data: { date: new Date() } });
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();

  // Wait long enough to give the defer handler a chance to run (it shouldn't)
  await sleep(2000);
  expect(state.deferHandlerReached).toBe(false);
});

test("defer without schema defaults to any", async () => {
  const parentState = createState({
    deferredData: null as Record<string, unknown> | null,
  });
  const deferState = createState({
    eventData: null as Record<string, unknown> | null,
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(client, { id: "foo" }, async ({ event, runId }) => {
    deferState.runId = runId;
    deferState.eventData = event.data;
  });
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      defer("foo", { function: foo, data: { key: "value" } });
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();
  expect(deferState.eventData).toEqual({ key: "value" });
});

test("mixed defer functions: with and without schema", () => {
  const client = new Inngest({ id: "type-test-4", isDev: true });

  const withSchema = createDefer(
    client,
    { id: "with-schema", schema: z.object({ msg: z.string() }) },
    async ({ event }) => {
      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data.msg).toBeString();
    },
  );
  const withoutSchema = createDefer(
    client,
    { id: "without-schema" },
    async ({ event }) => {
      expectTypeOf(event.data).not.toBeAny();
      expectTypeOf(event.data).toEqualTypeOf<Record<string, any>>();
    },
  );

  client.createFunction(
    {
      id: "mixed-defer",
      triggers: { event: "test" },
    },
    async ({ defer }) => {
      defer("a", { function: withSchema, data: { msg: "hi" } });
      defer("b", { function: withoutSchema, data: { anything: true } });
    },
  );
});
