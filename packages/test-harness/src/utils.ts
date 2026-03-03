import path from "path";
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

/**
 * Unwrap the raw run output from the dev server.
 *
 * v4 wraps the function return value in a RunComplete op array, e.g.
 * `[{ op: "RunComplete", data: 3, id: "..." }]`. This extracts the
 * inner `data` field so callers get the plain return value.
 */
function unwrapRunOutput(parsed: unknown): unknown {
  if (Array.isArray(parsed) && parsed.length === 1) {
    const item = parsed[0];
    if (
      item &&
      typeof item === "object" &&
      "op" in item &&
      item.op === "RunComplete" &&
      "data" in item
    ) {
      return item.data;
    }
  }
  return parsed;
}

async function fetchRunResult(
  runId: string,
  timeout = 20_000,
): Promise<RunResult> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query ($runId: String!) {
          run(runID: $runId) {
            output
            status
          }
        }`,
        variables: { runId },
      }),
    });
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const data = (await res.json()) as {
      data: {
        run: { output: string | null; status: string } | null;
      };
    };
    if (data.data.run?.output) {
      const parsed = JSON.parse(data.data.run.output);

      if (data.data.run.status === "COMPLETED") {
        // The output may be wrapped in a RunComplete op array;
        // unwrap to return just the function's return value.
        const unwrapped = unwrapRunOutput(parsed);
        return { data: unwrapped };
      }
      if (data.data.run.status === "FAILED") {
        return { error: parsed };
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

  async waitForRunFailed(): Promise<void> {
    const runId = await this.waitForRunId();
    const result = await fetchRunResult(runId);
    if (!result.error) {
      throw new Error(
        `Expected run ${runId} to fail, but it completed with: ${JSON.stringify(result.data)}`,
      );
    }
  }
}

export function createState<T extends Record<string, unknown>>(
  initial?: T,
): BaseState & T {
  return Object.assign(new BaseState(), initial);
}
