import { durablePath } from "../durable.ts";
import { CiUsageError } from "../errors.ts";
import { getJobScope, getRunScope, requireRunScope } from "../scope.ts";
import type { CheckConclusion, Duration } from "../types.ts";
import { hash } from "../util.ts";
import type { Octokit } from "./auth.ts";
import { mapGitHubError, octokitForRun, rest } from "./rest.ts";
import { hasPermission, type Permission } from "./triggers.ts";

/**
 * Run a helper's body as a single step, so all the calls it makes retry
 * together. Inside the step, `github.rest` calls run directly.
 */
const helperStep = async <T>(
  helper: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const run = requireRunScope(`github.${helper}`);

  // Inside a step already — a helper calling `github.paginate`, or user code
  // grouping calls in `step.run` — this runs directly rather than nesting.
  if (await insideStep()) {
    return fn();
  }

  const job = getJobScope();
  const id = `${job ? `${job.path} › ` : ""}github › ${helper}:${key}`;

  return run.step.run({ id, name: id }, fn) as Promise<T>;
};

const insideStep = async (): Promise<boolean> => {
  const { getAsyncCtx } = await import("../../execution/als.ts");
  const ctx = await getAsyncCtx();
  return Boolean(ctx?.execution?.executingStep);
};

/**
 * The repository a run is for, in the shape Octokit's methods want.
 */
export interface RunRepo {
  /** The owner, as in `owner/name`. */
  owner: string;
  /** The repository name, as in `owner/name`. */
  repo: string;
  /** The commit this run is for: a pull request's head, or a push's after. */
  sha: string;
  /** The pull request number, when the run came from one. */
  number?: number;
  /** The branch or tag, when the trigger carried one. */
  ref?: string;
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * The repository this run is for, plus the pull request number when there is
 * one.
 *
 * ```ts
 * const { owner, repo, sha, number } = github.repo();
 * ```
 *
 * @throws {CiUsageError} When the run has no repository, as with a cron that
 * doesn't set `repo` on its pipeline.
 */
export const repo = (): RunRepo => {
  const run = requireRunScope("github.repo");

  if (!run.repo) {
    throw new CiUsageError(
      'This run has no repository. Triggers like crons don\'t carry one; set `repo: "owner/name"` on the pipeline to give it one.',
    );
  }

  return {
    owner: run.repo.owner,
    repo: run.repo.name,
    sha: run.repo.sha,
    ...(run.repo.pullRequest ? { number: run.repo.pullRequest.number } : {}),
    ...(run.repo.ref ? { ref: run.repo.ref } : {}),
  };
};

const requireInsideStep = async (api: string): Promise<void> => {
  const { getAsyncCtx } = await import("../../execution/als.ts");
  const ctx = await getAsyncCtx();

  // Outside a function run there's nothing to memoize, so a direct call is
  // fine. Inside one, the token or client must not escape a step.
  if (ctx?.execution && !ctx.execution.executingStep) {
    throw new CiUsageError(
      `\`${api}\` must be called inside \`step.run\`, so its credentials never appear in step input or output.`,
    );
  }
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * A short-lived installation token, for the `gh` CLI or `fetch`.
 *
 * ```ts
 * await step.run("gh-cli", async () => {
 *   const token = await github.token();
 *   await $`gh pr comment 7 --body hi`.env({ GH_TOKEN: token });
 * });
 * ```
 *
 * @throws {CiUsageError} When called outside `step.run`, because a token in a
 * step's input or output would be visible in the trace.
 */
export const token = async (): Promise<string> => {
  await requireInsideStep("github.token()");

  const run = getRunScope();
  const provider = run?.ci.github;

  if (!provider) {
    throw new CiUsageError(
      "No GitHub provider is configured. Pass `github: githubApp({ … })` to `createCi`.",
    );
  }

  return provider.token({
    ...(run?.repo?.installationId === undefined
      ? {}
      : { installationId: run.repo.installationId }),
  });
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * A plain Octokit client, for streams and anything `github.rest` can't do.
 *
 * ```ts
 * await step.run("stream-artifact", async () => {
 *   const client = await github.octokit();
 *   for await (const page of client.paginate.iterator(…)) { … }
 * });
 * ```
 *
 * @throws {CiUsageError} When called outside `step.run`, because the client
 * carries credentials that must not reach step input or output.
 */
export const octokit = async (): Promise<Octokit> => {
  await requireInsideStep("github.octokit()");
  return octokitForRun();
};

/**
 * A `github.rest` method that returns a list, which is what `paginate` takes.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches any durable list method
export type DurableListMethod = (params?: any) => Promise<readonly unknown[]>;

/** The parameters a `github.rest` method takes. */
export type ParamsOf<TMethod> = TMethod extends (params?: infer TParams) => void
  ? TParams
  : never;

/** One item from the list a `github.rest` method returns. */
export type ItemOf<TMethod extends DurableListMethod> = Awaited<
  ReturnType<TMethod>
> extends readonly (infer TItem)[]
  ? TItem
  : never;

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Fetch every page of a list method.
 *
 * The item type comes from the method, so the result is typed without saying
 * what it is:
 *
 * ```ts
 * const comments = await github.paginate(github.rest.issues.listComments, {
 *   issue_number: 7,
 * });
 *
 * comments[0]?.body; // string | undefined
 * ```
 *
 * @param method - A list method from `github.rest`, passed rather than called.
 * @param params - The method's parameters. `owner` and `repo` default to the
 * run's repository.
 */
export const paginate = async <TMethod extends DurableListMethod>(
  method: TMethod,
  params?: ParamsOf<TMethod>,
): Promise<ItemOf<TMethod>[]> => {
  const path = methodPath(method);

  const call = async () => {
    const client = await octokitForRun();
    const resolved = resolveMethod(client, path);

    try {
      // Octokit's `paginate` overloads are written for literal routes and
      // concrete methods; the value resolved above is one of its own methods,
      // which satisfies them at runtime.
      const runPaginate = client.paginate as (
        method: unknown,
        params?: Record<string, unknown>,
      ) => Promise<unknown[]>;

      return (await runPaginate(resolved, {
        ...repoParamsIfKnown(),
        ...(params as Record<string, unknown> | undefined),
      })) as ItemOf<TMethod>[];
    } catch (error) {
      const mapped = mapGitHubError(error);
      throw mapped ?? error;
    }
  };

  if (!getRunScope()) {
    return call();
  }

  return helperStep("paginate", path.join("."), call);
};

/**
 * Run a GraphQL query.
 */
export const graphql = async <T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const call = async () => {
    const client = await octokitForRun();
    try {
      return (await client.graphql(query, variables)) as T;
    } catch (error) {
      const mapped = mapGitHubError(error);
      throw mapped ?? error;
    }
  };

  if (!getRunScope()) {
    return call();
  }

  return helperStep("graphql", hash(query, 8), call);
};

/**
 * `github.paginate(github.rest.issues.listComments, …)` is handed a durable
 * proxy rather than a real method, so the path it stands for is read off it
 * and resolved against a real client inside the step.
 */
const methodPath = (method: unknown): string[] => {
  const path = durablePath(method);

  if (!path || path.length === 0) {
    throw new CiUsageError(
      "`github.paginate()` needs a list method from `github.rest`, like `github.rest.issues.listComments`.",
    );
  }

  return path;
};

const resolveMethod = (client: Octokit, path: string[]): unknown => {
  let value: unknown = client.rest;

  for (const segment of path) {
    value = (value as Record<string, unknown> | undefined)?.[segment];
  }

  if (typeof value !== "function") {
    throw new CiUsageError(
      `\`github.rest.${path.join(".")}\` isn't a method on Octokit.`,
    );
  }

  return value;
};

const repoParamsIfKnown = (): Record<string, unknown> => {
  const current = getRunScope()?.repo;
  return current ? { owner: current.owner, repo: current.name } : {};
};

/**
 * Create one pull request comment, and update it on later runs.
 */
export const stickyComment = async (
  key: string,
  body: string,
  opts?: { issueNumber?: number },
): Promise<{ id: number; url: string }> =>
  helperStep("stickyComment", key, async () => {
    const context = repo();
    const issueNumber = opts?.issueNumber ?? context.number;

    if (!issueNumber) {
      throw new CiUsageError(
        "`github.stickyComment()` needs a pull request. This run doesn't have one, so pass `{ issueNumber }`.",
      );
    }

    const marker = `<!-- inngest-ci:${key} -->`;
    const text = `${marker}\n${body}`;

    const comments = await paginate(rest.issues.listComments, {
      issue_number: issueNumber,
    });

    const existing = comments.find((comment) => comment.body?.includes(marker));

    const result = existing
      ? await rest.issues.updateComment({
          comment_id: existing.id,
          body: text,
        })
      : await rest.issues.createComment({
          issue_number: issueNumber,
          body: text,
        });

    return { id: result.id, url: result.html_url };
  });

/**
 * Open a pull request, or update the one that's already open.
 */
export const upsertPullRequest = async (opts: {
  head: string;
  base?: string;
  title: string;
  body: string;
  draft?: boolean;
}): Promise<{ number: number; url: string; created: boolean }> =>
  helperStep("upsertPullRequest", opts.head, async () => {
    const context = repo();
    const base =
      opts.base ?? (await rest.repos.get({})).default_branch ?? "main";

    const open = await rest.pulls.list({
      state: "open",
      head: `${context.owner}:${opts.head}`,
      base,
    });

    const existing = open[0];

    if (existing) {
      const updated = await rest.pulls.update({
        pull_number: existing.number,
        title: opts.title,
        body: opts.body,
      });
      return { number: updated.number, url: updated.html_url, created: false };
    }

    const created = await rest.pulls.create({
      head: opts.head,
      base,
      title: opts.title,
      body: opts.body,
      ...(opts.draft === undefined ? {} : { draft: opts.draft }),
    });

    return { number: created.number, url: created.html_url, created: true };
  });

/**
 * Move a branch or tag to a commit, creating it if it doesn't exist.
 */
export const forcePushRef = async (
  ref: string,
  sha: string,
): Promise<{ created: boolean }> =>
  helperStep("forcePushRef", ref, async () => {
    const normalised = ref.replace(/^refs\//, "");

    try {
      await rest.git.updateRef({ ref: normalised, sha, force: true });
      return { created: false };
    } catch (error) {
      const status = (error as { status?: number; cause?: { status?: number } })
        .status;
      const message = error instanceof Error ? error.message : String(error);

      const missing =
        status === 422 ||
        message.includes("422") ||
        message.toLowerCase().includes("reference does not exist");

      if (!missing) {
        throw error;
      }

      await rest.git.createRef({ ref: `refs/${normalised}`, sha });
      return { created: true };
    }
  });

/**
 * Whether a user has at least the given permission on the repository.
 */
export const canUser = async (
  login: string,
  permission: Permission,
): Promise<boolean> =>
  helperStep("canUser", `${login}:${permission}`, async () => {
    try {
      const result = await rest.repos.getCollaboratorPermissionLevel({
        username: login,
      });
      return hasPermission(result.permission, permission);
    } catch {
      // A 403 or 404 here means "can't see it", which is the same as "no".
      return false;
    }
  });

/**
 * Wait for other checks on a commit to finish, without keeping a machine busy.
 *
 * Checks that have already completed are read once; the rest are waited for as
 * events. An event that arrives between the read and the wait is missed, so
 * that name times out; fixing that needs executor support.
 */
export const waitForChecks = async (opts: {
  names: string[];
  sha?: string;
  timeout?: Duration;
}): Promise<Record<string, CheckConclusion | "timed_out">> => {
  const run = requireRunScope("github.waitForChecks");
  const sha = opts.sha ?? run.repo?.sha;

  if (!sha) {
    throw new CiUsageError(
      "`github.waitForChecks()` needs a commit. This run has no repository, so pass `{ sha }`.",
    );
  }

  const known = await helperStep(
    "waitForChecks",
    hash(opts.names.join(","), 8),
    async () => {
      const result = await rest.checks.listForRef({ ref: sha });
      const completed: Record<string, string> = {};

      for (const checkRun of result.check_runs ?? []) {
        if (
          checkRun.status === "completed" &&
          checkRun.conclusion &&
          opts.names.includes(checkRun.name)
        ) {
          completed[checkRun.name] = checkRun.conclusion;
        }
      }

      return completed;
    },
  );

  const missing = opts.names.filter((name) => !(name in known));

  const waited = await Promise.all(
    missing.map(async (name) => {
      const event = (await run.step.waitForEvent(
        {
          id: `github › waitForChecks:${name}`,
          name: `waitForChecks:${name}`,
        },
        {
          event: "github/check_run.completed",
          timeout: opts.timeout ?? "1h",
          if: `async.data.check_run.name == "${name}" && async.data.check_run.head_sha == "${sha}"`,
        },
        // biome-ignore lint/suspicious/noExplicitAny: event shape is the user's
      )) as any;

      return [
        name,
        (event?.data?.check_run?.conclusion ?? "timed_out") as CheckConclusion,
      ] as const;
    }),
  );

  return {
    ...(known as Record<string, CheckConclusion>),
    ...Object.fromEntries(waited),
  };
};

/**
 * Wait for a GitHub Actions workflow run to finish.
 */
export const waitForWorkflow = async (opts: {
  workflow: string;
  sha?: string;
  timeout?: Duration;
}): Promise<CheckConclusion | "timed_out"> => {
  const run = requireRunScope("github.waitForWorkflow");
  const sha = opts.sha ?? run.repo?.sha;

  if (!sha) {
    throw new CiUsageError(
      "`github.waitForWorkflow()` needs a commit. This run has no repository, so pass `{ sha }`.",
    );
  }

  const known = await helperStep("waitForWorkflow", opts.workflow, async () => {
    const result = await rest.actions.listWorkflowRuns({
      workflow_id: opts.workflow,
      head_sha: sha,
    });

    const completed = (result.workflow_runs ?? []).find(
      (workflowRun) => workflowRun.status === "completed",
    );

    return completed?.conclusion ?? null;
  });

  if (known) {
    return known as CheckConclusion;
  }

  const event = (await run.step.waitForEvent(
    {
      id: `github › waitForWorkflow:${opts.workflow}`,
      name: `waitForWorkflow:${opts.workflow}`,
    },
    {
      event: "github/workflow_run.completed",
      timeout: opts.timeout ?? "1h",
      if: `async.data.workflow_run.head_sha == "${sha}"`,
    },
    // biome-ignore lint/suspicious/noExplicitAny: event shape is the user's
  )) as any;

  return (event?.data?.workflow_run?.conclusion ?? "timed_out") as
    | CheckConclusion
    | "timed_out";
};
