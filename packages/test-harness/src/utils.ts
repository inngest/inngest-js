import path from "path";
import { z } from "zod/v3";
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
    run: z
      .object({
        trace: z
          .object({
            status: z.string(),
            outputID: z.string().nullable(),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

const traceOutputSchema = z.object({
  data: z.object({
    runTraceSpanOutputByID: z
      .object({
        data: z.string().nullable(),
        error: z
          .object({
            message: z.string(),
            name: z.string(),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

/**
 * Fetch the trace status and output ID for a run via the Dev Server's GQL API.
 * Uses `run.trace.status` instead of `run.status` because the top-level status
 * can be stale (e.g. stuck as QUEUED) for sync-mode durable endpoint runs.
 */
async function fetchRunTrace(runId: string): Promise<{
  status: string;
  outputID: string | null;
} | null> {
  const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query ($runId: String!) {
        run(runID: $runId) {
          status
          trace(preview: true) {
            status
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
  const parsed = runTraceSchema.safeParse(await res.json());
  if (!parsed.success) {
    return null;
  }
  return parsed.data.data.run?.trace ?? null;
}

/**
 * Fetch the output data/error for a trace span by its output ID.
 */
async function fetchTraceOutput(outputID: string): Promise<RunResult> {
  const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `query ($traceID: String!) {
        runTraceSpanOutputByID(outputID: $traceID) {
          data
          error {
            message
            name
          }
        }
      }`,
      variables: { traceID: outputID },
    }),
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  const parsed = traceOutputSchema.parse(await res.json());
  const span = parsed.data.runTraceSpanOutputByID;
  if (span?.error) {
    return { error: span.error };
  }
  if (span?.data) {
    try {
      return { data: JSON.parse(span.data) };
    } catch {
      return { data: span.data };
    }
  }
  return { data: null };
}

async function fetchRunResult(
  runId: string,
  timeout = 20_000,
): Promise<RunResult> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const trace = await fetchRunTrace(runId);
    if (trace) {
      if (trace.status === "COMPLETED") {
        if (trace.outputID) {
          return fetchTraceOutput(trace.outputID);
        }
        return { data: null };
      }
      if (trace.status === "FAILED") {
        if (trace.outputID) {
          return fetchTraceOutput(trace.outputID);
        }
        return { error: { message: "Run failed (no output)" } };
      }
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
    const result = await fetchRunResult(runId);
    if (result.error) {
      throw new Error(
        `Expected run ${runId} to complete, but it errored: ${JSON.stringify(result.error)}`,
      );
    }
    return result.data;
  }

  async waitForRunFailed(): Promise<unknown> {
    const runId = await this.waitForRunId();
    const result = await fetchRunResult(runId);
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
