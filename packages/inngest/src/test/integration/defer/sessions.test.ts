import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { createDefer } from "../../../experimental.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

// A defer's session layers ride `opts.meta` on the op rather than an event
// payload, so there is no emitted event to inspect; the deferred run's
// `ctx.sessions` is the only observable outcome.

test("a deferred run inherits the calling run's sessions", async () => {
  const parentState = createState({});
  const deferState = createState({
    sessions: undefined as Record<string, string> | undefined,
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    sessionPropagation: true,
  });
  const eventName = randomSuffix("evt");

  const foo = createDefer(client, { id: "foo" }, (ctx) => {
    deferState.runId = ctx.runId;
    deferState.sessions = ctx.sessions;
  });
  const parent = client.createFunction(
    { id: "parent", retries: 0, triggers: [{ event: eventName }] },
    ({ defer, runId }) => {
      parentState.runId = runId;
      defer("foo", { function: foo, data: {} });
    },
  );
  await createTestApp({
    client,
    functions: [parent, foo],
    serve: createServer,
  });

  await client.send({
    data: {},
    meta: { sessions: { org: "acme" } },
    name: eventName,
  });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();

  expect(deferState.sessions).toEqual({ org: "acme" });
});

test("a deferred run's manual sessions override the inherited ones", async () => {
  const parentState = createState({});
  const deferState = createState({
    sessions: undefined as Record<string, string> | undefined,
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    sessionPropagation: true,
  });
  const eventName = randomSuffix("evt");

  const foo = createDefer(client, { id: "foo" }, (ctx) => {
    deferState.runId = ctx.runId;
    deferState.sessions = ctx.sessions;
  });
  const parent = client.createFunction(
    { id: "parent", retries: 0, triggers: [{ event: eventName }] },
    ({ defer, runId }) => {
      parentState.runId = runId;
      defer("foo", {
        data: {},
        function: foo,
        meta: { sessions: { org: "override" } },
      });
    },
  );
  await createTestApp({
    client,
    functions: [parent, foo],
    serve: createServer,
  });

  await client.send({
    data: {},
    meta: { sessions: { org: "acme", team: "core" } },
    name: eventName,
  });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();

  expect(deferState.sessions).toEqual({ org: "override", team: "core" });
});

test("the client toggle stops propagation reaching a deferred run", async () => {
  const parentState = createState({});
  const deferState = createState({
    ran: false,
    sessions: undefined as Record<string, string> | undefined,
  });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    sessionPropagation: false,
  });
  const eventName = randomSuffix("evt");

  const foo = createDefer(client, { id: "foo" }, (ctx) => {
    deferState.runId = ctx.runId;
    deferState.ran = true;
    deferState.sessions = ctx.sessions;
  });
  const parent = client.createFunction(
    { id: "parent", retries: 0, triggers: [{ event: eventName }] },
    ({ defer, runId }) => {
      parentState.runId = runId;
      defer("foo", { function: foo, data: {} });
    },
  );
  await createTestApp({
    client,
    functions: [parent, foo],
    serve: createServer,
  });

  await client.send({
    data: {},
    meta: { sessions: { org: "acme" } },
    name: eventName,
  });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();

  expect(deferState.ran).toBe(true);
  expect(deferState.sessions).toBeUndefined();
});
