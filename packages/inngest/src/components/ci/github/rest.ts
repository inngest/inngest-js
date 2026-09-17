import type { RestEndpointMethodTypes } from "@octokit/rest";

import type { Jsonify } from "../../../helpers/jsonify.ts";
import { NonRetriableError } from "../../NonRetriableError.ts";
import { RetryAfterError } from "../../RetryAfterError.ts";
import { durable } from "../durable.ts";
import { CiUsageError } from "../errors.ts";
import { getRunScope } from "../scope.ts";
import type { GitHubProvider, Octokit } from "./auth.ts";

export type { RestEndpointMethodTypes };

type RestEndpointMethods = Octokit["rest"];

/**
 * A method's parameters with `owner` and `repo` made optional, since they
 * default to the run's repository.
 *
 * This is written as two mapped types with `as` clauses rather than
 * `Omit`/`Pick`: Octokit's parameters carry a string index signature, and
 * `Omit` over such a type collapses every specific key into the index
 * signature — which would quietly accept `{ pull_number: "7" }`.
 */
type RepoDefaults<TParams> = {
  [K in keyof TParams as K extends "owner" | "repo" ? never : K]: TParams[K];
} & {
  [K in keyof TParams as K extends "owner" | "repo" ? K : never]?: TParams[K];
};

/**
 * Octokit's REST methods, with `owner` and `repo` optional and each method
 * returning the response's `data` as it will be stored by the step.
 */
export type DurableGitHubRest = {
  [NS in keyof RestEndpointMethods]: {
    [M in keyof RestEndpointMethods[NS]]: RestEndpointMethods[NS][M] extends (
      params?: infer P,
    ) => Promise<{ data: infer D }>
      ? (params?: RepoDefaults<P>) => Promise<Jsonify<D>>
      : never;
  };
} & {
  /** Set the step ID and name for the next call. */
  with(opts: { id?: string; name?: string }): DurableGitHubRest;
};

/**
 * Whoever should answer for `github.*` calls when there's no run in progress,
 * like a script or a test. Set by the most recent `createCi()`.
 */
let fallbackProvider: GitHubProvider | undefined;
let fallbackInstallationId: number | undefined;

export const setFallbackGitHub = (
  provider: GitHubProvider,
  installationId?: number,
): void => {
  fallbackProvider = provider;
  fallbackInstallationId = installationId;
};

/**
 * The Octokit client for the current run's repository.
 *
 * Built inside the step that uses it, so its installation token never appears
 * in step input or output.
 */
export const octokitForRun = async (): Promise<Octokit> => {
  const run = getRunScope();
  const provider = (run?.ci.github ?? fallbackProvider) as
    | GitHubProvider
    | undefined;

  if (!provider) {
    throw new CiUsageError(
      "No GitHub provider is configured. Pass `github: githubApp({ … })` or `githubToken({ … })` to `createCi`.",
    );
  }

  const installationId =
    run?.repo?.installationId ?? fallbackInstallationId ?? undefined;

  return provider.octokit({
    ...(installationId === undefined ? {} : { installationId }),
    ...(run?.repo ? { owner: run.repo.owner, repo: run.repo.name } : {}),
  });
};

/**
 * The repository a run is for, as Octokit params.
 */
export const currentRepoParams = ():
  | { owner: string; repo: string }
  | undefined => {
  const repo = getRunScope()?.repo;
  return repo ? { owner: repo.owner, repo: repo.name } : undefined;
};

const takesOwnerAndRepo = (method: unknown): boolean => {
  const url = (
    method as { endpoint?: { DEFAULTS?: { url?: string } } } | undefined
  )?.endpoint?.DEFAULTS?.url;

  return typeof url === "string" && url.includes("{owner}");
};

interface RequestErrorish {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | undefined> };
}

/**
 * Map Octokit errors onto Inngest's, so rate limits reschedule the retry
 * instead of holding a worker, and client errors don't retry at all.
 */
export const mapGitHubError = (error: unknown): Error | undefined => {
  const err = error as RequestErrorish;
  const status = err?.status;

  if (typeof status !== "number") {
    return undefined;
  }

  const headers = err.response?.headers ?? {};
  const remaining = headers["x-ratelimit-remaining"];
  const retryAfter = headers["retry-after"];
  const reset = headers["x-ratelimit-reset"];

  if (
    (status === 403 || status === 429) &&
    (remaining === "0" || retryAfter !== undefined)
  ) {
    const retryAt = retryAfter
      ? Number(retryAfter) * 1000
      : reset
        ? new Date(Number(reset) * 1000)
        : 60_000;

    return new RetryAfterError(
      `GitHub rate limit reached: ${err.message ?? "rate limited"}`,
      retryAt,
      { cause: error },
    );
  }

  if (status >= 500) {
    // Server errors and network failures retry as normal step errors.
    return undefined;
  }

  if (status >= 400) {
    return new NonRetriableError(`GitHub ${status}: ${err.message ?? ""}`, {
      cause: error,
    });
  }

  return undefined;
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Every Octokit REST method, with each call run as a step.
 */
export const rest: DurableGitHubRest = durable<DurableGitHubRest>(
  () => octokitForRun().then((octokit) => octokit.rest),
  {
    name: "github",
    // Every method under `octokit.rest` is exactly one HTTP request.
    rules: [["*.*", "step"]],
    argsWithMethod: (args, { method }) => {
      if (!takesOwnerAndRepo(method)) {
        return args;
      }

      const defaults = currentRepoParams();
      if (!defaults) {
        return args;
      }

      const params = (args[0] ?? {}) as Record<string, unknown>;
      return [{ ...defaults, ...params }, ...args.slice(1)];
    },
    result: (value) => (value as { data?: unknown })?.data,
    onError: (error) => mapGitHubError(error),
    unsupportedMessage: (path) =>
      `\`github.rest.${path.join(".")}\` returns a stream, so it can't be a step. Call it inside \`step.run\` with \`github.octokit()\`.`,
  },
);
