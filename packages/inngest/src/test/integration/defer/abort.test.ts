import {
  createState,
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect } from "vitest";
import { createDefer } from "../../../experimental.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import { matrixCheckpointing } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

matrixCheckpointing("aborted defer never runs", async (checkpointing) => {
  const parentState = createState({});
  const deferState = createState({});

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    checkpointing,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
    deferState.runId = runId;
  });
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: { event: eventName },
    },
    async ({ defer, runId }) => {
      parentState.runId = runId;
      const ref = defer("foo", { function: foo, data: {} });
      ref.abort();
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();

  // Wait long enough to give the aborted defer a chance to run (it shouldn't)
  await sleep(5000);
  expect(deferState.runId).toBeNull();
});

matrixCheckpointing(
  "abort after the add has shipped prevents the deferred run",
  async (checkpointing) => {
    // The step between the defer and the abort forces the `DeferAdd` to ship
    // before the abort is emitted, exercising the shipped-target path.

    const parentState = createState({});
    const deferState = createState({});

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      checkpointing,
    });
    const eventName = randomSuffix("evt");
    const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
      deferState.runId = runId;
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ defer, runId, step }) => {
        parentState.runId = runId;
        const ref = defer("foo", { function: foo, data: {} });
        await step.run("between", async () => {});
        ref.abort();
      },
    );
    await createTestApp({
      client,
      functions: [fn, foo],
      serve: createServer,
    });

    await client.send({ name: eventName, data: {} });
    await parentState.waitForRunComplete();

    await sleep(5000);
    expect(deferState.runId).toBeNull();
  },
);

matrixCheckpointing(
  "abort inside step.run ships with the step result",
  async (checkpointing) => {
    // The sleep forces the add to ship before the aborting step runs, so the
    // abort emitted inside the step closure is bundled with the step result.

    const parentState = createState({});
    const deferState = createState({});

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      checkpointing,
    });
    const eventName = randomSuffix("evt");
    const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
      deferState.runId = runId;
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ defer, runId, step }) => {
        parentState.runId = runId;
        const ref = defer("foo", { function: foo, data: {} });
        await step.sleep("pause", "1s");
        await step.run("abort", async () => {
          ref.abort();
        });
      },
    );
    await createTestApp({
      client,
      functions: [fn, foo],
      serve: createServer,
    });

    await client.send({ name: eventName, data: {} });
    await parentState.waitForRunComplete();

    await sleep(5000);
    expect(deferState.runId).toBeNull();
  },
);

matrixCheckpointing(
  "defer and abort inside the same step closure",
  async (checkpointing) => {
    // Both the add and the abort happen inside one `step.run` closure: the
    // add is cancelled locally and the abort ships alone. On re-entry the
    // memoized step doesn't re-run, so nothing is re-added.

    const parentState = createState({});
    const deferState = createState({});

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      checkpointing,
    });
    const eventName = randomSuffix("evt");
    const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
      deferState.runId = runId;
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ defer, runId, step }) => {
        parentState.runId = runId;
        await step.run("defer-and-abort", async () => {
          const ref = defer("foo", { function: foo, data: {} });
          ref.abort();
        });

        // Force reentry so the memoized step is replayed
        await step.sleep("pause", "1s");
      },
    );
    await createTestApp({
      client,
      functions: [fn, foo],
      serve: createServer,
    });

    await client.send({ name: eventName, data: {} });
    await parentState.waitForRunComplete();

    await sleep(5000);
    expect(deferState.runId).toBeNull();
  },
);

matrixCheckpointing(
  "unaborted defers still run alongside an aborted one",
  async (checkpointing) => {
    const parentState = createState({});
    const abortedState = createState({});
    const keptState = createState({});

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      checkpointing,
    });
    const eventName = randomSuffix("evt");
    const aborted = createDefer(
      client,
      { id: "aborted" },
      async ({ runId }) => {
        abortedState.runId = runId;
      },
    );
    const kept = createDefer(client, { id: "kept" }, async ({ runId }) => {
      keptState.runId = runId;
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ defer, runId }) => {
        parentState.runId = runId;
        const ref = defer("aborted", { function: aborted, data: {} });
        defer("kept", { function: kept, data: {} });
        ref.abort();
      },
    );
    await createTestApp({
      client,
      functions: [fn, aborted, kept],
      serve: createServer,
    });

    await client.send({ name: eventName, data: {} });
    await parentState.waitForRunComplete();
    await keptState.waitForRunComplete();

    await sleep(5000);
    expect(abortedState.runId).toBeNull();
  },
);
