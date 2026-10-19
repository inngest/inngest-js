/**
 * The Dev Server: starting an isolated one for the run, and the few REST calls
 * the CLI makes to it. Never GraphQL.
 *
 * @module
 */

import { setTimeout as sleep } from "node:timers/promises";

import type { LocalStatus } from "../local/protocol.ts";
import { shortReason } from "../util.ts";
import type { ManagedProcess } from "./processes.ts";
import { freePorts, logTail, scrubbedEnv, startProcess } from "./processes.ts";
import type { SandboxAccessProblem } from "./sandboxAccess.ts";
import { sandboxAccessProblem } from "./sandboxAccess.ts";
import { SetupError } from "./setupError.ts";

const startTimeoutMs = 30_000;
const requestTimeoutMs = 5000;

export interface DevServer {
  /** Where the Dev Server and its UI are, like `http://127.0.0.1:24288`. */
  url: string;

  process: ManagedProcess;
}

/**
 * Start a Dev Server that finds nothing on its own, listens on ports of its
 * own and syncs only `appUrl`, then wait until it's healthy. The binary is
 * `INNGEST_CI_DEV_SERVER_BIN`, or `inngest-cli` through `npx`.
 */
export const startDevServer = async (opts: {
  appUrl: string;
  cwd: string;
  logPath: string;
}): Promise<DevServer> => {
  const [main, gateway, gatewayGrpc, executorGrpc, debug] = await freePorts(5);
  const url = `http://127.0.0.1:${main}`;
  const bin = process.env.INNGEST_CI_DEV_SERVER_BIN;

  const proc = startProcess({
    command: bin ?? "npx",
    args: [
      ...(bin ? [] : ["--yes", "inngest-cli@latest"]),
      "dev",
      "--no-discovery",
      "--host",
      "127.0.0.1",
      "--port",
      String(main),
      "--connect-gateway-port",
      String(gateway),
      "--connect-gateway-grpc-port",
      String(gatewayGrpc),
      "--connect-executor-grpc-port",
      String(executorGrpc),
      "--debug-api-port",
      String(debug),
      "-u",
      opts.appUrl,
    ],
    cwd: opts.cwd,
    env: scrubbedEnv(),
    logPath: opts.logPath,
  });

  const deadline = Date.now() + startTimeoutMs;

  while (!(await isHealthy(url))) {
    const failure =
      (proc.hasExited() && "The Dev Server exited before it was ready.") ||
      (Date.now() > deadline && "The Dev Server was not ready after 30s.");

    if (failure) {
      await proc.stop();

      throw new SetupError(failure, { logTail: logTail(proc.logPath) });
    }

    await sleep(100);
  }

  return { url, process: proc };
};

const request = (url: string, path: string, init?: RequestInit) => {
  return fetch(`${url}${path}`, {
    ...init,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
};

/** `GET path` as JSON. A non-2xx answer throws. */
const getJson = async <T>(url: string, path: string): Promise<T> => {
  const response = await request(url, path);

  if (!response.ok) {
    throw new Error(`GET ${path} answered ${response.status}`);
  }

  return (await response.json()) as T;
};

const isHealthy = async (url: string): Promise<boolean> => {
  try {
    return (await request(url, "/health")).ok;
  } catch {
    return false;
  }
};

/** The IDs of the functions the Dev Server has synced. */
export const listFunctionIds = async (url: string): Promise<string[]> => {
  const body = await getJson<{ functions?: { slug: string }[] }>(url, "/dev");

  return (body.functions ?? []).map((fn) => {
    return fn.slug;
  });
};

/** Send an event, returning its ID. */
export const sendEvent = async (
  url: string,
  event: { name: string; data: Record<string, unknown> },
): Promise<string> => {
  const response = await request(url, "/e/local", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    throw new Error(`POST /e/local answered ${response.status}`);
  }

  const id = ((await response.json()) as { ids?: string[] }).ids?.[0];

  if (!id) {
    throw new Error("POST /e/local returned no event ID");
  }

  return id;
};

/** How the Dev Server names the statuses that end a run. */
const terminalStatuses: Record<string, LocalStatus> = {
  COMPLETED: "passed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

/** A run, as far as the CLI cares. */
export interface RunInfo {
  id: string;
  functionId: string;
  eventIds: string[];

  /** Set once the run has ended. */
  terminal?: LocalStatus;
}

/**
 * Every run the Dev Server has. The list is the only way to get from an event
 * to a run, and `GET /v2/runs/{id}` answers COMPLETED while a run still goes.
 */
export const listRuns = async (url: string): Promise<RunInfo[]> => {
  const body = await getJson<{
    data?: {
      id: string;
      status: string;
      function: { id: string };
      trigger?: { eventIds?: string[] };
    }[];
  }>(url, "/v2/runs");

  return (body.data ?? []).map((run) => {
    return {
      id: run.id,
      functionId: run.function.id,
      eventIds: run.trigger?.eventIds ?? [],
      terminal: terminalStatuses[run.status],
    };
  });
};

export const cancelRun = async (url: string, runId: string): Promise<void> => {
  await request(url, `/v2/runs/${runId}/cancel`, { method: "POST" });
};

/**
 * Why a run failed, from its output: the run's own error, such as a step's
 * `NonRetriableError` that ended it before any check could say so. Asking
 * never fails the run it describes.
 */
export const runFailureReason = async (
  url: string,
  runId: string,
): Promise<string | undefined> => {
  try {
    const { data } = await getJson<{ data?: { output?: unknown } }>(
      url,
      `/v2/runs/${runId}?includeOutput=true`,
    );

    // A run that threw answers with the error as its output.
    const output = data?.output;

    return (
      shortReason(typeof output === "string" ? { message: output } : output) ||
      undefined
    );
  } catch {
    return undefined;
  }
};

/**
 * Whether Sandboxes can be used through the Dev Server, asked with two
 * read-only calls: its Cloud login status, then a one-item list of Sandboxes,
 * which Cloud refuses with `access_denied` when the account has no access.
 * Anything unexpected (an older Dev Server without the routes, a network blip)
 * is no problem here; the first Sandbox call that fails says so later.
 */
export const sandboxAccessProblemOf = async (
  url: string,
): Promise<SandboxAccessProblem | undefined> => {
  for (const path of ["/dev/cloud/status", "/v2/sandboxes?limit=1"]) {
    try {
      const response = await request(url, path);

      if (!response.ok) {
        const body = (await response.json()) as {
          errors?: { code?: string }[];
        };
        const problem = sandboxAccessProblem(body.errors?.[0]?.code);

        if (problem) {
          return problem;
        }
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
};
