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

    if (data.data.run) {
      const { output } = data.data.run;
      if (output) {
        const parsed = JSON.parse(output);

        if (data.data.run.status === "COMPLETED") {
          return { data: maybeParseRunCompleteOp(parsed) };
        }
        if (data.data.run.status === "FAILED") {
          return { error: parsed };
        }
      }
    }

    await sleep(400);
  }

  throw new Error(`Timed out waiting for run ${runId} to end`);
}

/**
 * Hack to handle GQL returning an op array when checkpointing is enabled. It's handling data like this:
 * ```json
 * [
 *   {
 *    "data": "fn return value",
 *    "id": "0737c22d3bfae812339732d14d8c7dbd6dc4e09c",
 *    "op": "RunComplete",
 *   }
 * ]
 * ```
 * 
 * TODO: Fix the GQL query and delete this function.
 */
function maybeParseRunCompleteOp(output: unknown): unknown {
  if (!Array.isArray(output)) {
    return output;
  }

  const [op] = output;
  if (!isRecord(op)) {
    return output;
  }
  if (op.op !== "RunComplete") {
    return output;
  }
  return op.data;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
