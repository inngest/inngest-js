import { createState, sleep, testNameFromFileUrl } from "@inngest/test-harness";
import { describe, expect, test } from "vitest";
import { fetchWithStream } from "../../../durable-endpoints/client.ts";
import { stream } from "../../../durable-endpoints/index.ts";
import { NonRetriableError, step } from "../../../index.ts";
import { silencedLogger } from "../../helpers.ts";
import { createGate, setupEndpoint, urlWithTestName } from "./helpers.ts";

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

  const resp = await fetchWithStream(
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
  const resp = await fetchWithStream(
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

  const resp = await fetchWithStream(
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
  const resp = await fetchWithStream(
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

describe("failed", () => {
  test("sync mode", async () => {
    const { port } = await setupEndpoint(testFileName, async () => {
      await step.run("a", async () => {
        stream.push("chunk");
        throw new NonRetriableError("oh no");
      });
      return Response.json("unreachable");
    });

    const resp = await fetchWithStream(
      urlWithTestName(`http://localhost:${port}`),
    );
    expect(resp.status).toBe(500);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(await resp.json()).toEqual("oh no");
  });

  test("async mode", async () => {
    const { port } = await setupEndpoint(testFileName, async () => {
      await step.sleep("go-async", "1s");
      try {
        await step.run("a", async () => {
          stream.push("chunk");
          throw new NonRetriableError("oh no");
        });
      } catch (e) {
        if (e instanceof Error) {
          // Wait a little bit to handle the "late joining client" race
          // condition. We should eventually fix that problem, but for now this
          // is the best we can do.
          await sleep(1000);

          return Response.json(e.message, { status: 500 });
        }
      }
      return Response.json("unreachable");
    });

    const resp = await fetchWithStream(
      urlWithTestName(`http://localhost:${port}`),
    );
    expect(resp.status).toBe(500);
    expect(resp.headers.get("content-type")).toBe("application/json");
    expect(await resp.json()).toEqual("oh no");
  });
});

describe("server killed mid-stream", () => {
  test("sync mode", async () => {
    const gate = createGate();
    const { port, server } = await setupEndpoint(testFileName, async () => {
      await step.run("a", async () => {
        stream.push("before-kill");
        // Pause here so the test can kill the server mid-execution.
        await gate.promise;
        stream.push("after-kill");
      });
      return Response.json("unreachable");
    });

    expect(async () => {
      await fetchWithStream(urlWithTestName(`http://localhost:${port}`), {
        onData: () => {
          // Kill the server after we've received the first chunk.
          server.closeAllConnections();
          server.close();
          gate.open();
        },
      });
    }).rejects.toThrow("terminated");
  });

  test("async mode", async () => {
    const gate = createGate();
    const { port, server } = await setupEndpoint(testFileName, async () => {
      await step.sleep("go-async", "1s");
      await step.run("a", async () => {
        stream.push("before-kill");
        // Pause here so the test can kill the server mid-execution.
        await gate.promise;
        stream.push("after-kill");
      });
      return Response.json("unreachable");
    });

    // FIXME: Times out because the server dies before sending the
    // "inngest.response" SSE event. This is a consequence of endpoint-side
    // orchestration for the stream. We need a way for the Inngest server to
    // tell the client that the endpoint died.
    const timeoutSignal = AbortSignal.timeout(5_000);
    expect(async () => {
      await fetchWithStream(urlWithTestName(`http://localhost:${port}`), {
        fetchOpts: {
          signal: timeoutSignal,
        },
        onData: () => {
          // Kill the server after we've received the first chunk.
          server.closeAllConnections();
          server.close();
          gate.open();
        },
      });
    }).rejects.toThrow("The operation was aborted due to timeout");
  });
});

describe("header forwarding normalizes all HeadersInit shapes", () => {
  test("forwards headers passed as a Headers instance", async () => {
    const state = createState({});
    const { port, waitForRunId } = await setupEndpoint(
      testFileName,
      async (req) => {
        const value = req.headers.get("X-Custom-Header");
        return Response.json({ echoedHeader: value });
      },
    );

    const resp = await fetchWithStream(
      urlWithTestName(`http://localhost:${port}`),
      {
        fetchOpts: {
          headers: new Headers({ "X-Custom-Header": "test-value" }),
        },
      },
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ echoedHeader: "test-value" });

    state.runId = await waitForRunId();
    await state.waitForRunComplete();
  });

  test("forwards headers passed as an array of tuples", async () => {
    const state = createState({});
    const { port, waitForRunId } = await setupEndpoint(
      testFileName,
      async (req) => {
        const value = req.headers.get("X-Custom-Header");
        return Response.json({ echoedHeader: value });
      },
    );

    const resp = await fetchWithStream(
      urlWithTestName(`http://localhost:${port}`),
      {
        fetchOpts: {
          headers: [["X-Custom-Header", "test-value"]],
        },
      },
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ echoedHeader: "test-value" });

    state.runId = await waitForRunId();
    await state.waitForRunComplete();
  });

  test("forwards headers passed as a plain object", async () => {
    const state = createState({});
    const { port, waitForRunId } = await setupEndpoint(
      testFileName,
      async (req) => {
        const value = req.headers.get("X-Custom-Header");
        return Response.json({ echoedHeader: value });
      },
    );

    const resp = await fetchWithStream(
      urlWithTestName(`http://localhost:${port}`),
      {
        fetchOpts: {
          headers: { "X-Custom-Header": "test-value" },
        },
      },
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ echoedHeader: "test-value" });

    state.runId = await waitForRunId();
    await state.waitForRunComplete();
  });
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

  const resp = await fetchWithStream(url, {
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
