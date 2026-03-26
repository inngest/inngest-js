import { createState, testNameFromFileUrl } from "@inngest/test-harness";
import { expect, test, vi } from "vitest";
import { stream } from "../../../experimental/durable-endpoints.ts";
import { step } from "../../../index.ts";
import { streamRun } from "../../../stream.ts";
import { silencedLogger } from "../../helpers.ts";
import { setupEndpoint } from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

// TODO: Fails in CI because the dev server doesn't support durable endpoints yet
test.fails("async mode", async () => {
  const state = createState({});
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("sync-data");
      return "a output";
    });
    await step.sleep("go-async", "1s");
    await step.run("b", async () => {
      stream.push("async-data");
      return "b output";
    });
    return Response.json("fn output");
  });

  const { calls, runId } = await collectCalls(
    `http://localhost:${port}/api/demo`,
  );
  state.runId = runId;

  expect(calls).toEqual({
    onData: [
      {
        data: "sync-data",
        hashedStepId: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8",
      },
      {
        data: "async-data",
        hashedStepId: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98",
      },
    ],
    onDone: [undefined],
    onStreamError: [],

    onFunctionCompleted: [{ data: "fn output" }],

    onMetadata: [
      { runId: expect.any(String) },
      { runId: expect.any(String) },
      { runId: expect.any(String) },
    ],
    onRollback: [],
    onStepCompleted: [
      { hashedStepId: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8" },
      { hashedStepId: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98" },
    ],
    onStepRunning: [
      { hashedStepId: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8" },
      { hashedStepId: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98" },
    ],
  });

  await state.waitForRunComplete();
});

// TODO: Fails in CI because the dev server doesn't support durable endpoints yet
test.fails("retries", async () => {
  const state = createState({});
  let shouldError = true;
  const { port } = await setupEndpoint(
    testFileName,
    async () => {
      await step.run("a", async () => {
        stream.push("sync-data");
        if (shouldError) {
          shouldError = false;
          throw new Error("oh no");
        }
        shouldError = true;
        return "a output";
      });
      await step.sleep("go-async", "1s");
      await step.run("b", async () => {
        stream.push("async-data");
        if (shouldError) {
          shouldError = false;
          throw new Error("oh no");
        }
        shouldError = true;
        return "b output";
      });
      return Response.json("fn output");
    },
    { logger: silencedLogger },
  );

  const { calls, runId } = await collectCalls(
    `http://localhost:${port}/api/demo`,
  );
  state.runId = runId;

  expect(calls).toEqual({
    onData: [
      {
        data: "sync-data",
        hashedStepId: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8",
      },
      {
        data: "sync-data",
        hashedStepId: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8",
      },
      {
        data: "async-data",
        hashedStepId: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98",
      },
      {
        data: "async-data",
        hashedStepId: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98",
      },
    ],
    onDone: [undefined],
    onStreamError: [],

    onFunctionCompleted: [{ data: "fn output" }],

    onMetadata: [
      { runId: expect.any(String) },
      { runId: expect.any(String) },
      { runId: expect.any(String) },
      { runId: expect.any(String) },
      { runId: expect.any(String) },
    ],
    onRollback: [undefined, undefined],
    onStepCompleted: [
      { hashedStepId: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8" },
      { hashedStepId: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98" },
    ],
    onStepRunning: [
      { hashedStepId: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8" },
      { hashedStepId: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8" },
      { hashedStepId: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98" },
      { hashedStepId: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98" },
    ],
  });

  await state.waitForRunComplete();
});

// TODO: Fails in CI because the dev server doesn't support durable endpoints yet
test.fails("rollback", async () => {
  // Test an abstraction that automatically rolls back retried stream items

  const state = createState({});
  let shouldError = true;
  const { port } = await setupEndpoint(
    testFileName,
    async () => {
      await step.run("a", async () => {
        stream.push("sync-data");
        if (shouldError) {
          shouldError = false;
          throw new Error("oh no");
        }
        shouldError = true;
        return "a output";
      });
      await step.sleep("go-async", "1s");
      await step.run("b", async () => {
        stream.push("async-data");
        if (shouldError) {
          shouldError = false;
          throw new Error("oh no");
        }
        shouldError = true;
        return "b output";
      });
      return Response.json("fn output");
    },
    { logger: silencedLogger },
  );

  const { chunks, rawChunks, runId } = await rollbacker(
    `http://localhost:${port}/api/demo`,
  );
  state.runId = runId;

  // After rollback: errored attempts' chunks are removed
  expect(chunks).toEqual(["sync-data", "async-data"]);

  // Raw: every chunk received, including ones later rolled back
  expect(rawChunks).toEqual([
    "sync-data",
    "sync-data",
    "async-data",
    "async-data",
  ]);

  await state.waitForRunComplete();
});

// Verifies the endpoint controls its response — the client sees whatever the
// endpoint returns through onFunctionCompleted, including error-shaped data.
// TODO: Fails in CI because the dev server doesn't support durable endpoints yet
test.fails("endpoint error response via onFunctionCompleted", async () => {
  const state = createState({});
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("some-data");
    });
    await step.sleep("go-async", "1s");

    // The endpoint decides to return an error based on application logic.
    // No special failure hook needed — onFunctionCompleted carries the result.
    return Response.json({ error: "something went wrong" });
  });

  const completed: { data: unknown }[] = [];
  const done = vi.fn();

  const rs = streamRun(`http://localhost:${port}/api/demo`, {
    onFunctionCompleted: (args) => completed.push(args),
    onMetadata: (args) => {
      state.runId = args.runId;
    },
    onDone: done,
  });
  await rs;

  expect(completed).toHaveLength(1);
  expect(completed[0]!.data).toEqual({
    error: "something went wrong",
  });
  expect(done).toHaveBeenCalledOnce();

  await state.waitForRunComplete();
});

async function collectCalls(url: string) {
  const calls = {
    onData: [] as { data: unknown; hashedStepId?: string }[],
    onDone: [] as undefined[],
    onStreamError: [] as undefined[],
    onFunctionCompleted: [] as { data: unknown }[],
    onMetadata: [] as { runId: string }[],
    onRollback: [] as undefined[],
    onStepCompleted: [] as { hashedStepId: string }[],
    onStepRunning: [] as { hashedStepId: string }[],
  };
  let runId = "";

  const rs = streamRun(url, {
    onData: (args) => {
      calls.onData.push(args);
    },
    onDone: () => {
      calls.onDone.push(undefined);
    },
    onStreamError: () => {
      calls.onStreamError.push(undefined);
    },
    onFunctionCompleted: (args) => {
      calls.onFunctionCompleted.push(args);
    },
    onMetadata: (args) => {
      calls.onMetadata.push(args);
      runId = args.runId;
    },
    onRollback: () => {
      calls.onRollback.push(undefined);
    },
    onStepCompleted: (args) => {
      calls.onStepCompleted.push(args);
    },
    onStepRunning: (args) => {
      calls.onStepRunning.push(args);
    },
  });
  await rs;

  return { calls, runId };
}

/**
 * Handle rollbacks due to step retries
 */
async function rollbacker(
  url: string,
): Promise<{ chunks: string[]; rawChunks: string[]; runId: string }> {
  const rawChunks: string[] = [];
  const committed: string[] = [];
  let inProgress: string[] = [];
  let runId = "";

  const rs = streamRun<string>(url, {
    onMetadata: (args) => {
      runId = args.runId;
    },
    onData: ({ data }) => {
      rawChunks.push(data);
      inProgress.push(data);
    },
    onStepCompleted: () => {
      committed.push(...inProgress);
      inProgress = [];
    },
    onRollback: () => {
      inProgress = [];
    },
  });
  await rs;

  return { chunks: committed, rawChunks, runId };
}
