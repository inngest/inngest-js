/**
 * The Dev Server's REST API: the only calls the CLI makes to it. Never
 * GraphQL.
 *
 * @module
 */

import type { LocalStatus } from "../local/protocol.ts";
import { shortReason } from "../util.ts";
import {
  type SandboxAccessProblem,
  sandboxAccessProblem,
} from "./sandboxAccess.ts";

const requestTimeoutMs = 5000;

const request = (url: string, init?: RequestInit): Promise<Response> => {
  return fetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
};

/** How the Dev Server names a run's status, for the ones that end a run. */
const terminalStatuses: Record<string, LocalStatus> = {
  COMPLETED: "passed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

/** A run, as far as the CLI cares. */
export interface RunInfo {
  id: string;
  /** Set once the run has ended. */
  terminal?: LocalStatus;
}

/**
 * The first meaningful line of a failed run's output. A single run answers
 * with the error as the output (`{ name, message, stack }`), and the list
 * wraps it (`{ error: { … } }`); a run that threw a bare string is the string.
 */
export const failureReason = (output: unknown): string | undefined => {
  const first = (text: unknown): string | undefined => {
    return typeof text === "string"
      ? shortReason({ message: text }) || undefined
      : undefined;
  };

  if (typeof output !== "object" || output === null) {
    return first(output);
  }

  const { error, message, name } = output as {
    error?: unknown;
    message?: unknown;
    name?: unknown;
  };

  return (
    first(message) ??
    failureReason(error) ??
    (typeof error === "string" ? first(error) : undefined) ??
    first(name)
  );
};

/** Whether the Dev Server answers its health check. */
export const isHealthy = async (devServerUrl: string): Promise<boolean> => {
  try {
    return (await request(`${devServerUrl}/health`)).ok;
  } catch {
    return false;
  }
};

/** The slugs (`<appId>-<fnId>`) of every function the Dev Server has synced. */
export const listFunctionSlugs = async (
  devServerUrl: string,
): Promise<string[]> => {
  const response = await request(`${devServerUrl}/dev`);

  if (!response.ok) {
    throw new Error(`GET /dev answered ${response.status}`);
  }

  const body = (await response.json()) as { functions?: { slug: string }[] };

  return (body.functions ?? []).map((fn) => {
    return fn.slug;
  });
};

/** Send an event, returning its ID. */
export const sendEvent = async (
  devServerUrl: string,
  event: { name: string; data: Record<string, unknown> },
): Promise<string> => {
  const response = await request(`${devServerUrl}/e/local`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    throw new Error(`POST /e/local answered ${response.status}`);
  }

  const body = (await response.json()) as { ids?: string[] };
  const id = body.ids?.[0];

  if (!id) {
    throw new Error("POST /e/local returned no event ID");
  }

  return id;
};

interface RunBody {
  id: string;
  status: string;
}

const toRunInfo = (run: RunBody): RunInfo => {
  return { id: run.id, terminal: terminalStatuses[run.status] };
};

/**
 * The run that an event started for a function, if it has started. The list
 * is the only way to get from an event to a run.
 */
export const findRun = async (
  devServerUrl: string,
  eventId: string,
  functionId: string,
): Promise<RunInfo | undefined> => {
  const response = await request(`${devServerUrl}/v2/runs`);

  if (!response.ok) {
    throw new Error(`GET /v2/runs answered ${response.status}`);
  }

  const body = (await response.json()) as {
    data?: (RunBody & {
      function: { id: string };
      trigger?: { eventIds?: string[] };
    })[];
  };

  const run = body.data?.find((candidate) => {
    return (
      candidate.function.id === functionId &&
      candidate.trigger?.eventIds?.includes(eventId)
    );
  });

  return run ? toRunInfo(run) : undefined;
};

/**
 * Why a run failed, from its output: the run's own error, such as a step's
 * `NonRetriableError` that ended it before any check could say so. Asking
 * for it never fails the run it describes.
 */
export const runFailureReason = async (
  devServerUrl: string,
  runId: string,
): Promise<string | undefined> => {
  try {
    const response = await request(
      `${devServerUrl}/v2/runs/${runId}?includeOutput=true`,
    );

    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as { data?: { output?: unknown } };

    return failureReason(body.data?.output);
  } catch {
    return undefined;
  }
};

/** Ask the Dev Server to cancel a run. */
export const cancelRun = async (
  devServerUrl: string,
  runId: string,
): Promise<void> => {
  await request(`${devServerUrl}/v2/runs/${runId}/cancel`, { method: "POST" });
};

/** The ID of the most recent run, which the list starts with. */
export const latestRunId = async (
  devServerUrl: string,
): Promise<string | undefined> => {
  const response = await request(`${devServerUrl}/v2/runs?limit=1`);

  if (!response.ok) {
    throw new Error(`GET /v2/runs answered ${response.status}`);
  }

  const body = (await response.json()) as { data?: { id: string }[] };

  return body.data?.[0]?.id;
};

/** Whether the Dev Server knows a run. */
export const runExists = async (
  devServerUrl: string,
  runId: string,
): Promise<boolean> => {
  return (await request(`${devServerUrl}/v2/runs/${runId}`)).ok;
};

/** The `code` of the first error in a Sandbox API error body, if it has one. */
const errorCode = async (response: Response): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as { errors?: { code?: unknown }[] };
    const code = body.errors?.[0]?.code;

    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether Sandboxes can be used through the Dev Server, asked with two
 * read-only calls: its Cloud login status, then a one-item list of Sandboxes,
 * which Cloud refuses with `access_denied` when the account has no access.
 * `/dev`'s `authed` isn't used: the Dev Server never sets it. Anything
 * unexpected (an older Dev Server without the routes, a network blip) is no
 * problem here; the first Sandbox call that fails says so later.
 */
export const sandboxAccessProblemOf = async (
  devServerUrl: string,
): Promise<SandboxAccessProblem | undefined> => {
  for (const path of ["/dev/cloud/status", "/v2/sandboxes?limit=1"]) {
    try {
      const response = await request(`${devServerUrl}${path}`);

      if (response.ok) {
        continue;
      }

      const problem = sandboxAccessProblem({ code: await errorCode(response) });

      if (problem) {
        return problem;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
};
