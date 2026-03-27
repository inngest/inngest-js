import { createState, testNameFromFileUrl } from "@inngest/test-harness";
import { expect, test } from "vitest";
import { fetchDurableEndpoint } from "../../../experimental/durable-endpoints/client.ts";
import { stream } from "../../../experimental/durable-endpoints.ts";
import { step } from "../../../index.ts";
import { silencedLogger } from "../../helpers.ts";
import { setupEndpoint, urlWithTestName } from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("sync mode with no stream", async () => {
  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {});
    await step.run("b", async () => {});
    return Response.json("fn output", {
      headers: { "X-My-Header": "my-value" },
      status: 202,
    });
  });

  const resp = await fetchDurableEndpoint(
    urlWithTestName(`http://localhost:${port}`),
  );
  expect(resp.status).toBe(202);
  expect(resp.headers.get("X-My-Header")).toBe("my-value");
  expect(await resp.json()).toBe("fn output");

  state.runId = await waitForRunId();
  await state.waitForRunComplete();
});

test("sync mode with stream", async () => {
  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("chunk a");
    });
    await step.run("b", async () => {
      stream.push("chunk b");
    });
    return Response.json("fn output", {
      headers: { "X-My-Header": "my-value" },
      status: 202,
    });
  });

  const chunks: unknown[] = [];
  const resp = await fetchDurableEndpoint(
    urlWithTestName(`http://localhost:${port}`),
    {
      onData: (args) => {
        chunks.push(args.data);
      },
    },
  );
  expect(resp.status).toBe(202);
  expect(resp.headers.get("X-My-Header")).toBe("my-value");
  expect(await resp.json()).toBe("fn output");
  expect(chunks).toEqual(["chunk a", "chunk b"]);

  state.runId = await waitForRunId();
  await state.waitForRunComplete();
});

test("async mode without stream", async () => {
  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {});
    await step.sleep("go-async", "1s");
    await step.run("b", async () => {});
    return Response.json("fn output", {
      headers: { "X-My-Header": "my-value" },
      status: 202,
    });
  });

  const resp = await fetchDurableEndpoint(
    urlWithTestName(`http://localhost:${port}`),
  );
  expect(resp.status).toBe(202);
  expect(resp.headers.get("X-My-Header")).toBe("my-value");
  expect(await resp.json()).toBe("fn output");
  state.runId = await waitForRunId();
  await state.waitForRunComplete();
});

test("async mode with stream", async () => {
  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("chunk a");
    });
    await step.sleep("go-async", "1s");
    await step.run("b", async () => {
      stream.push("chunk b");
    });
    return Response.json("fn output", {
      headers: { "X-My-Header": "my-value" },
      status: 202,
    });
  });

  const chunks: unknown[] = [];
  const resp = await fetchDurableEndpoint(
    urlWithTestName(`http://localhost:${port}`),
    {
      onData: (args) => {
        chunks.push(args.data);
      },
    },
  );
  expect(resp.status).toBe(202);
  expect(resp.headers.get("X-My-Header")).toBe("my-value");
  expect(await resp.json()).toBe("fn output");
  expect(chunks).toEqual(["chunk a", "chunk b"]);

  state.runId = await waitForRunId();
  await state.waitForRunComplete();
});

test("rollback", async () => {
  // Test an abstraction that automatically rolls back retried stream items

  const state = createState({});
  let shouldError = true;
  const { port, waitForRunId } = await setupEndpoint(
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

  const { chunks, rawChunks } = await rollbacker(
    urlWithTestName(`http://localhost:${port}`),
  );
  state.runId = await waitForRunId();

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

/**
 * Handle rollbacks due to step retries
 */
async function rollbacker(url: string): Promise<{
  chunks: unknown[];
  rawChunks: unknown[];
  resp: Response;
  runId: string;
}> {
  const rawChunks: unknown[] = [];
  const committed: unknown[] = [];
  let inProgress: unknown[] = [];
  let runId = "";

  const resp = await fetchDurableEndpoint(url, {
    onMetadata: (args) => {
      runId = args.runId;
    },
    onData: ({ data }) => {
      rawChunks.push(data);
      inProgress.push(data);
    },
    onCommit: () => {
      committed.push(...inProgress);
      inProgress = [];
    },
    onRollback: () => {
      inProgress = [];
    },
  });

  return { chunks: committed, rawChunks, resp, runId };
}
