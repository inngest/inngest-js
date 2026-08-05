import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";
import { matrixCheckpointing } from "./utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

// These tests assert on `ctx.sessions` rather than on the emitted event's
// `meta`, because the Dev Server does not expose an event's `meta` blob through
// its GraphQL API. That makes every test here an end-to-end check: the SDK
// stamps `meta.propagated_sessions`, the server folds it into `meta.sessions`
// at finalize, and the receiving run derives `ctx.sessions` from that.

/**
 * A client with session propagation explicitly enabled.
 */
function createClient(opts?: {
  checkpointing?: boolean;
  sessionPropagation?: boolean;
}) {
  return new Inngest({
    checkpointing: opts?.checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    sessionPropagation: opts?.sessionPropagation ?? true,
  });
}

test("ctx.sessions round-trips from a directly-sent event", async () => {
  const state = createState({
    sessions: undefined as Record<string, string> | undefined,
  });

  const client = createClient();
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    (ctx) => {
      state.runId = ctx.runId;
      state.sessions = ctx.sessions;
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({
    data: {},
    meta: { sessions: { org: "acme" } },
    name: eventName,
  });
  await state.waitForRunComplete();

  expect(state.sessions).toEqual({ org: "acme" });
});

test("ctx.sessions is the intersection of a batch's events", async () => {
  // The reducer is unit-tested; this asserts the run actually receives every
  // triggering event's `meta` so the intersection has something to work with.

  const state = createState({
    eventCount: 0,
    sessions: undefined as Record<string, string> | undefined,
  });

  const client = createClient();
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    {
      batchEvents: { maxSize: 2, timeout: "5s" },
      id: "fn",
      retries: 0,
      triggers: [{ event: eventName }],
    },
    (ctx) => {
      state.runId = ctx.runId;
      state.eventCount = ctx.events.length;
      state.sessions = ctx.sessions;
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  // Sent as one call so both events land in the same batch; two separate sends
  // can straddle batches and give the run only one of them.
  await client.send([
    {
      data: {},
      meta: { sessions: { org: "acme", tenant: "x" } },
      name: eventName,
    },
    {
      data: {},
      meta: { sessions: { org: "acme", tenant: "y" } },
      name: eventName,
    },
  ]);
  await state.waitForRunComplete();

  expect(state.eventCount).toBe(2);

  // `org` agrees across both events and survives; `tenant` disagrees and is
  // dropped.
  expect(state.sessions).toEqual({ org: "acme" });
});

matrixCheckpointing(
  "step.sendEvent propagates sessions to the child run",
  async (checkpointing) => {
    const parentState = createState({});
    const childState = createState({
      sessions: undefined as Record<string, string> | undefined,
    });

    const client = createClient({ checkpointing });
    const eventName = randomSuffix("evt");
    const childEventName = randomSuffix("child");

    const parent = client.createFunction(
      { id: "parent", retries: 0, triggers: [{ event: eventName }] },
      async ({ runId, step }) => {
        parentState.runId = runId;
        await step.sendEvent("send-it", { name: childEventName, data: {} });
      },
    );
    const child = client.createFunction(
      { id: "child", retries: 0, triggers: [{ event: childEventName }] },
      (ctx) => {
        childState.runId = ctx.runId;
        childState.sessions = ctx.sessions;
      },
    );
    await createTestApp({
      client,
      functions: [parent, child],
      serve: createServer,
    });

    await client.send({
      data: {},
      meta: { sessions: { org: "acme" } },
      name: eventName,
    });
    await parentState.waitForRunComplete();
    await childState.waitForRunComplete();

    expect(childState.sessions).toEqual({ org: "acme" });
  },
);

test("step.invoke propagates sessions to the invoked run", async () => {
  const parentState = createState({});
  const childState = createState({
    sessions: undefined as Record<string, string> | undefined,
  });

  const client = createClient();
  const eventName = randomSuffix("evt");

  const child = client.createFunction(
    { id: "child", retries: 0, triggers: [{ event: randomSuffix("never") }] },
    (ctx) => {
      childState.runId = ctx.runId;
      childState.sessions = ctx.sessions;
    },
  );
  const parent = client.createFunction(
    { id: "parent", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId, step }) => {
      parentState.runId = runId;
      await step.invoke("invoke-it", { function: child, data: {} });
    },
  );
  await createTestApp({
    client,
    functions: [parent, child],
    serve: createServer,
  });

  await client.send({
    data: {},
    meta: { sessions: { org: "acme" } },
    name: eventName,
  });
  await parentState.waitForRunComplete();

  expect(childState.sessions).toEqual({ org: "acme" });
});

matrixCheckpointing(
  "a bare client.send() inside a run propagates sessions",
  async (checkpointing) => {
    // Unlike `step.sendEvent`, this stamps from the run's async context, so it
    // exercises that the store survives a real request boundary.

    const parentState = createState({});
    const childState = createState({
      sessions: undefined as Record<string, string> | undefined,
    });

    const client = createClient({ checkpointing });
    const eventName = randomSuffix("evt");
    const childEventName = randomSuffix("child");

    const parent = client.createFunction(
      { id: "parent", retries: 0, triggers: [{ event: eventName }] },
      async ({ runId }) => {
        parentState.runId = runId;
        await client.send({ name: childEventName, data: {} });
      },
    );
    const child = client.createFunction(
      { id: "child", retries: 0, triggers: [{ event: childEventName }] },
      (ctx) => {
        childState.runId = ctx.runId;
        childState.sessions = ctx.sessions;
      },
    );
    await createTestApp({
      client,
      functions: [parent, child],
      serve: createServer,
    });

    await client.send({
      data: {},
      meta: { sessions: { org: "acme" } },
      name: eventName,
    });
    await parentState.waitForRunComplete();
    await childState.waitForRunComplete();

    expect(childState.sessions).toEqual({ org: "acme" });
  },
);

test("a manual session overrides the propagated one for the same key", async () => {
  // Both layers ride the same event; the server resolves manual over propagated
  // per key at finalize.

  const parentState = createState({});
  const childState = createState({
    sessions: undefined as Record<string, string> | undefined,
  });

  const client = createClient();
  const eventName = randomSuffix("evt");
  const childEventName = randomSuffix("child");

  const parent = client.createFunction(
    { id: "parent", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId, step }) => {
      parentState.runId = runId;
      await step.sendEvent("send-it", {
        data: {},
        meta: { sessions: { org: "override" } },
        name: childEventName,
      });
    },
  );
  const child = client.createFunction(
    { id: "child", retries: 0, triggers: [{ event: childEventName }] },
    (ctx) => {
      childState.runId = ctx.runId;
      childState.sessions = ctx.sessions;
    },
  );
  await createTestApp({
    client,
    functions: [parent, child],
    serve: createServer,
  });

  await client.send({
    data: {},
    meta: { sessions: { org: "acme", team: "core" } },
    name: eventName,
  });
  await parentState.waitForRunComplete();
  await childState.waitForRunComplete();

  // `org` is overridden by the manual layer; `team` is inherited untouched.
  expect(childState.sessions).toEqual({ org: "override", team: "core" });
});

test("the client toggle stops propagation reaching the child run", async () => {
  const parentState = createState({});
  const childState = createState({
    ran: false,
    sessions: undefined as Record<string, string> | undefined,
  });

  const client = createClient({ sessionPropagation: false });
  const eventName = randomSuffix("evt");
  const childEventName = randomSuffix("child");

  const parent = client.createFunction(
    { id: "parent", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId, step }) => {
      parentState.runId = runId;
      await step.sendEvent("send-it", { name: childEventName, data: {} });
    },
  );
  const child = client.createFunction(
    { id: "child", retries: 0, triggers: [{ event: childEventName }] },
    (ctx) => {
      childState.runId = ctx.runId;
      childState.ran = true;
      childState.sessions = ctx.sessions;
    },
  );
  await createTestApp({
    client,
    functions: [parent, child],
    serve: createServer,
  });

  await client.send({
    data: {},
    meta: { sessions: { org: "acme" } },
    name: eventName,
  });
  await parentState.waitForRunComplete();
  await childState.waitForRunComplete();

  expect(childState.ran).toBe(true);
  expect(childState.sessions).toBeUndefined();
});
