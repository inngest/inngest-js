import { createState, testNameFromFileUrl } from "@inngest/test-harness";
import { expect, test, vi } from "vitest";
import type { SseEvent } from "../../../components/execution/streaming.ts";
import { stream } from "../../../experimental/durable-endpoints.ts";
import { step } from "../../../index.ts";
import { streamRun } from "../../../stream.ts";
import { silencedLogger } from "../../helpers.ts";
import { setupEndpoint } from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("async mode", async () => {
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

test("retries", async () => {
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

test("rollback", async () => {
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
test("endpoint error response via onFunctionCompleted", async () => {
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

// XXX: not technically supported, but definitely works
test("stepless with streaming", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    stream.push("no-steps-data");
    return Response.json("stepless-streaming-done");
  });

  const { calls } = await collectCalls(`http://localhost:${port}/api/demo`);

  expect(calls).toEqual({
    onData: [{ data: "no-steps-data", hashedStepId: undefined }],
    onDone: [undefined],
    onStreamError: [],
    onFunctionCompleted: [{ data: "stepless-streaming-done" }],
    onMetadata: [{ runId: expect.any(String) }],
    onRollback: [],
    onStepCompleted: [],
    onStepRunning: [],
  });
});

test("stepless without streaming", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    return Response.json("stepless-no-stream");
  });

  const { calls } = await collectCalls(`http://localhost:${port}/api/demo`);

  expect(calls).toEqual({
    onData: [],
    onDone: [undefined],
    onStreamError: [],
    onFunctionCompleted: [{ data: "stepless-no-stream" }],
    onMetadata: [{ runId: expect.any(String) }],
    onRollback: [],
    onStepCompleted: [],
    onStepRunning: [],
  });
});

test("partial rollback — only erroring step's chunks are removed", async () => {
  const state = createState({});
  let bAttempt = 0;
  const { port } = await setupEndpoint(
    testFileName,
    async () => {
      await step.run("a", async () => {
        stream.push("a-data");
        return "a output";
      });
      await step.sleep("go-async", "1s");
      await step.run("b", async () => {
        bAttempt++;
        stream.push(`b-data-attempt-${bAttempt}`);
        if (bAttempt === 1) {
          throw new Error("b fails first time");
        }
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

  expect(chunks).toEqual(["a-data", "b-data-attempt-2"]);
  expect(rawChunks).toEqual(["a-data", "b-data-attempt-1", "b-data-attempt-2"]);

  await state.waitForRunComplete();
});

test("async iterable consumption via for-await-of", async () => {
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

  const collected: unknown[] = [];
  const rs = streamRun(`http://localhost:${port}/api/demo`, {
    onMetadata: (args) => {
      state.runId = args.runId;
    },
  });

  for await (const chunk of rs) {
    collected.push(chunk);
  }

  expect(collected).toEqual(["sync-data", "async-data"]);
  expect(rs.chunks).toEqual(["sync-data", "async-data"]);

  await state.waitForRunComplete();
});

test("disconnect rollback — in-flight step rolled back on stream end", async () => {
  const rolledBack: number[] = [];
  const dataChunks: { data: unknown; hashedStepId?: string }[] = [];
  const onDone = vi.fn();

  async function* fakeSource(): AsyncGenerator<SseEvent> {
    yield { type: "inngest.metadata", runId: "run-disconnect" };
    yield { type: "inngest.step", stepId: "s1", status: "running" };
    yield { type: "stream", data: "partial-a", stepId: "s1" };
    yield { type: "stream", data: "partial-b", stepId: "s1" };
  }

  const rs = streamRun<string>("http://unused", {
    onData: (d) => dataChunks.push(d),
    onRollback: ({ count }) => rolledBack.push(count),
    onDone,
  });
  rs._fromSource(fakeSource());
  await rs;

  expect(rolledBack).toEqual([2]);
  expect(rs.chunks).toEqual([]);
  expect(dataChunks).toEqual([
    { data: "partial-a", hashedStepId: "s1" },
    { data: "partial-b", hashedStepId: "s1" },
  ]);
  expect(onDone).toHaveBeenCalledOnce();
});

test("onStreamError fires on source error, onDone still fires", async () => {
  const streamErrors: unknown[] = [];
  const dataChunks: string[] = [];
  const onDone = vi.fn();

  async function* explodingSource(): AsyncGenerator<SseEvent> {
    yield { type: "inngest.metadata", runId: "run-error" };
    yield { type: "inngest.step", stepId: "s1", status: "running" };
    yield { type: "stream", data: "before-error", stepId: "s1" };
    throw new Error("connection reset");
  }

  const rs = streamRun<string>("http://unused", {
    onData: ({ data }) => dataChunks.push(data),
    onStreamError: ({ error }) => streamErrors.push(error),
    onDone,
  });
  rs._fromSource(explodingSource());

  await expect(rs).rejects.toThrow("connection reset");

  expect(streamErrors).toHaveLength(1);
  expect(streamErrors[0]).toBeInstanceOf(Error);
  expect((streamErrors[0] as Error).message).toBe("connection reset");
  expect(dataChunks).toEqual(["before-error"]);
  expect(onDone).toHaveBeenCalledOnce();
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
