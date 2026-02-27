import path from "path";
import { z } from "zod";
import { DEV_SERVER_URL } from "./devServer.ts";

export function randomSuffix(value: string): string {
  return `${value}-${Math.random().toString(36).substring(2, 15)}`;
}

export function testNameFromFileUrl(fileUrl: string): string {
  const basename = path.basename(fileUrl).split(".")[0];
  if (!basename) {
    throw new Error("unreachable");
  }
  return basename;
}

export async function sleep(ms: number = 1000): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a callback until it stops throwing, with a default 20s timeout.
 * Standalone implementation — no vitest dependency.
 */
export async function waitFor<T>(
  callback: () => T | Promise<T>,
  timeout = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await callback();
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }

  throw lastError;
}

type RunResult =
  | { data: unknown; error?: undefined }
  | { data?: undefined; error: unknown };

const runTraceSchema = z.object({
  data: z.object({
    run: z.nullable(
      z.object({
        trace: z.nullable(z.object({ outputID: z.nullable(z.string()) })),
      }),
    ),
  }),
});

const traceOutputSchema = z.object({
  data: z.object({
    runTraceSpanOutputByID: z.object({
      data: z.nullable(z.string()),
      error: z.nullable(z.object({ message: z.string(), name: z.string() })),
    }),
  }),
});

const runStatusSchema = z.object({
  data: z.object({
    run: z.nullable(z.object({ status: z.string() })),
  }),
});

async function fetchRunOutput(runId: string): Promise<RunResult> {
  const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query ($runId: String!) {
        run(runID: $runId) {
          trace {
            outputID
          }
        }
      }`,
      variables: { runId },
    }),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }

  const run = runTraceSchema.parse(await res.json());
  const outputId = run.data.run?.trace?.outputID;
  if (!outputId) {
    throw new Error(`No trace output found for run ${runId}`);
  }

  return fetchTraceOutput(outputId);
}

async function fetchTraceOutput(outputId: string): Promise<RunResult> {
  const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query ($outputId: String!) {
        runTraceSpanOutputByID(outputID: $outputId) {
          data
          error {
            message
            name
          }
        }
      }`,
      variables: { outputId },
    }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  const body = traceOutputSchema.parse(await res.json());
  const spanOutput = body.data.runTraceSpanOutputByID;

  if (spanOutput.error) {
    return { error: spanOutput.error };
  }

  let data: unknown = null;
  if (spanOutput.data) {
    data = JSON.parse(spanOutput.data);
  }

  return { data };
}

async function waitForRunEnd(
  runId: string,
  timeout = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query ($runId: String!) {
          run(runID: $runId) {
            status
          }
        }`,
        variables: { runId },
      }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }

    const data = runStatusSchema.parse(await res.json());
    const status = data.data.run?.status;
    if (status === "COMPLETED" || status === "FAILED") {
      return status;
    }

    await sleep(400);
  }

  throw new Error(`Timed out waiting for run ${runId} to end`);
}

export class BaseState {
  runId: string | null = null;

  async waitForRunId(): Promise<string> {
    return waitFor(async () => {
      if (this.runId === null) {
        throw new Error("runId not set yet");
      }
      return this.runId;
    });
  }

  async waitForRunComplete(): Promise<unknown> {
    const runId = await this.waitForRunId();
    const status = await waitForRunEnd(runId);
    if (status !== "COMPLETED") {
      throw new Error(
        `Expected run ${runId} to complete, but it has status: ${status}`,
      );
    }

    const result = await fetchRunOutput(runId);
    if (result.error) {
      throw new Error(
        `Expected run ${runId} to complete, but it errored: ${JSON.stringify(result.error)}`,
      );
    }
    return result.data;
  }

  async waitForRunFailed(): Promise<unknown> {
    const runId = await this.waitForRunId();
    const status = await waitForRunEnd(runId);
    if (status !== "FAILED") {
      throw new Error(
        `Expected run ${runId} to fail, but it has status: ${status}`,
      );
    }

    const result = await fetchRunOutput(runId);
    if (!result.error) {
      throw new Error(
        `Expected run ${runId} to fail, but it completed with: ${JSON.stringify(result.data)}`,
      );
    }
    return result.error;
  }
}

export function createState<T extends Record<string, unknown>>(
  initial?: T,
): BaseState & T {
  return Object.assign(new BaseState(), initial);
}
