/**
 * Defining and running a pipeline: the `ci.pipeline()` factory, the run itself
 * (scope, checks, cleanup), and the functions generated beside each pipeline
 * and for cache refreshes.
 *
 * @module
 */

import type { Inngest, InngestFunction } from "inngest";
import { internalEvents, NonRetriableError } from "inngest";
import type { AsyncContext, DurableSandboxTools } from "inngest/experimental";
import {
  getAsyncCtx,
  metadataMiddleware,
  sandboxMiddleware,
} from "inngest/experimental";
import {
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "../errors.ts";
import type { GitHubProvider } from "../github/auth.ts";
import type { CheckReporter } from "../github/checks.ts";
import { pipelineSummary } from "../github/checks.ts";
import {
  commentAuthor,
  commentBody,
  repoContextFromEvent,
} from "../github/events.ts";
import { canUser } from "../github/helpers.ts";
import { commentPermissionFor, type Permission } from "../github/triggers.ts";
import { destroyRunMachines } from "../machine/machine.ts";
import type {
  CiSkip,
  CiTrigger,
  CiTriggerInput,
  PipelineConfig,
  PipelineContext,
  RepoContext,
} from "../types.ts";
import { formatDuration, isSandboxNotFound } from "../util.ts";
import type { CacheBuildData } from "./cacheBuild.ts";
import type { RegisteredJob } from "./job.ts";
import { conclusionForError, runJob } from "./job.ts";
import { metadataStep, runEndMetadata, runStartMetadata } from "./metadata.ts";
import type { CiInternals, CiRunScope } from "./scope.ts";
import {
  apiNames,
  countApi,
  initCiAls,
  runInScope,
  withScopePreserved,
} from "./scope.ts";

export const definePipeline = ({
  client,
  internals,
  rawConfig,
  handler,
}: {
  client: Inngest.Any;
  internals: CiInternals;
  rawConfig: PipelineConfig;
  handler: (ctx: PipelineContext) => Promise<unknown>;
}): {
  fn: InngestFunction.Any;
  config: PipelineConfig;
  triggers: CiTrigger[];
  generated: InngestFunction.Any[];
} => {
  const triggers = flattenTriggers(rawConfig.on);

  if (triggers.length === 0) {
    throw new CiUsageError(
      `Pipeline "${rawConfig.id}" has no triggers. Pass \`on: github.pullRequest()\`, a cron, or \`ci.manual({ schema })\`.`,
    );
  }

  if (triggers.length > maxTriggersPerFunction) {
    throw new CiUsageError(
      `Pipeline "${rawConfig.id}" has ${triggers.length} triggers, and a function can have at most ${maxTriggersPerFunction}. Narrow \`types\` on the trigger, or split the pipeline in two.`,
    );
  }

  if (rawConfig.repo !== undefined) {
    parseRepo(rawConfig.repo);
  }

  // A comment trigger's `minPermission` can't be expressed in CEL, so it
  // travels beside the trigger and is checked when the run starts.
  const permissions = triggers.flatMap((trigger) => {
    const permission = commentPermissionFor(trigger);

    return permission ? [permission] : [];
  });

  const config: PipelineConfig = {
    ...rawConfig,
    ...(permissions.length > 0 ? { commentPermissions: permissions } : {}),
  };

  const fn = client.createFunction(
    {
      ...flowControl(config),
      id: config.id,
      triggers,
      middleware: [sandboxMiddleware(), metadataMiddleware()],
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
    async (ctx: any) => {
      return runPipeline({
        internals,
        config,
        handler,
        ctx,
      });
    },
  );

  return {
    fn,
    config,
    triggers,
    generated: generatedFunctions({ client, config }),
  };
};

/**
 * A function's triggers are declared with it, and the platform caps how many
 * it will take. Ten is the documented limit at the time of writing.
 */
const maxTriggersPerFunction = 10;

/**
 * `on` takes one trigger or any nesting of arrays of them, since
 * `github.pullRequest()` is itself an array. The executor wants one flat list.
 */
const flattenTriggers = (on: CiTriggerInput): CiTrigger[] => {
  return (Array.isArray(on) ? on.flat(Infinity) : [on]) as CiTrigger[];
};

const flowControl = (config: PipelineConfig) => {
  const {
    id: _id,
    on: _on,
    check: _check,
    machine: _machine,
    repo: _repo,
    commentPermissions: _commentPermissions,
    ...rest
  } = config;

  return rest;
};

interface RunPipelineArgs {
  internals: CiInternals;
  config: PipelineConfig;
  handler: (ctx: PipelineContext) => Promise<unknown>;
  /** Set when the run builds one job's cached snapshot for another run. */
  build?: CacheBuildData;
  // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
  ctx: any;
}

const newRunScope = ({
  internals,
  config,
  ctx,
  asyncCtx,
  build,
}: {
  internals: CiInternals;
  config: PipelineConfig;
  build?: CacheBuildData;
  // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
  ctx: any;
  asyncCtx: AsyncContext;
}): CiRunScope => {
  // A build starts with an event of its own, so it's told the repository.
  const repo = build?.repo ?? repoContextFromEvent(ctx.event);
  const attempt: number = ctx.attempt ?? 0;
  const retries = (config as { retries?: number }).retries ?? defaultRetries;
  const maxAttempts: number = ctx.maxAttempts ?? retries + 1;

  return {
    ci: internals,
    runId: ctx.runId,
    functionId: config.id,
    pipelineId: config.id,
    ...(config.check === false
      ? {}
      : { checkName: config.check?.name ?? config.id }),
    jobChecks: config.check === false ? false : config.check?.jobs !== false,
    ...(config.machine ? { machine: config.machine } : {}),
    event: ctx.event,
    ...(ctx.logger ? { logger: ctx.logger } : {}),
    ...(repo ? { repo } : {}),
    ...(build ? { build } : {}),
    jobs: new Map(),
    machines: new Map(),
    snapshots: new Map(),
    timings: [],
    cached: new Map(),
    sandboxes: new Set(),
    summaries: [],
    openChecks: new Map(),
    deferredChecks: new Map(),
    attempt,
    maxAttempts,
    willRetry: (error) => {
      return willRetry(error, attempt, maxAttempts);
    },
    // CI's own steps keep their scope inside the handler, so a call like
    // `github.rest` made from one still knows which run it's part of.
    step: withScopePreserved(ctx.step),
    sandboxTools: (ctx.step as { sandbox?: DurableSandboxTools })
      .sandbox as DurableSandboxTools,
    asyncCtx,
    counters: new Map(),
    snapshotsUnavailable: false,
    warnings: [],
    pipelineSummaries: [],
    pipelineAnnotations: [],
    apis: Object.fromEntries(
      apiNames.map((name) => {
        return [name, 0];
      }),
    ) as CiRunScope["apis"],
  };
};

/** Split a configured `repo` into its owner and name. */
const parseRepo = (fullName: string): { owner: string; name: string } => {
  const [owner, name, ...rest] = fullName.split("/");

  if (!owner || !name || rest.length > 0) {
    throw new CiUsageError(
      `\`repo\` must be "owner/name", but got "${fullName}".`,
    );
  }

  return { owner, name };
};

/**
 * Run a pipeline: set up the run scope, report the pipeline check, run the
 * handler, then always complete the check and destroy the machines.
 *
 * A usage error is the same on every attempt, so one thrown before the
 * handler's own error handling takes over is made non-retriable here.
 */
export const runPipeline = async (args: RunPipelineArgs): Promise<unknown> => {
  try {
    return await runPipelineAttempt(args);
  } catch (error) {
    if (error instanceof CiUsageError) {
      throw new NonRetriableError(error.message, { cause: error });
    }

    throw error;
  }
};

const runPipelineAttempt = async ({
  internals,
  config,
  handler,
  ctx,
  build,
}: RunPipelineArgs): Promise<unknown> => {
  await initCiAls();

  const asyncCtx = await getAsyncCtx();

  if (!asyncCtx?.execution) {
    throw new CiUsageError(
      "A pipeline ran without an Inngest execution context. Pipelines must be served through `serve()` with `ci.functions()`.",
    );
  }

  const run = newRunScope({
    internals,
    config,
    ctx,
    asyncCtx,
    ...(build ? { build } : {}),
  });
  const checks = internals.checks as CheckReporter;

  return runInScope({ run }, async () => {
    // A trigger with no repository of its own, like a cron, gets the one the
    // pipeline was configured with. Checks, checkout and cache keys all need
    // it, so it's resolved before any of them run.
    if (!run.repo && config.repo) {
      run.repo = await resolveConfiguredRepo(run, config.repo);
    }

    // A comment trigger knows its pull request but not the commit it's for.
    if (run.repo?.pullRequest && !run.repo.sha && !run.repo.local) {
      run.repo = await resolvePullRequestHead(run, run.repo);
    }

    // The check's step carries the run's metadata. With checks off there's no
    // such step, so one of its own does.
    const checkStarted = await checks.pipelineStart({
      run,
      metadata: () => {
        return runStartMetadata(run);
      },
    });

    if (checkStarted === undefined) {
      await metadataStep(run, "ci › metadata:start", () => {
        return runStartMetadata(run);
      });
    }

    // A run that is about to be retried keeps its machines: the retry replays
    // the memoized machine IDs and needs them alive. The generated cleanup
    // function covers the case where the retries run out.
    let retrying = false;

    try {
      const permitted = await checkCommentPermission(run, config);

      if (!permitted) {
        await completePipeline(run, checks, {
          conclusion: "neutral",
          title: "Not permitted",
          summary: pipelineSummary(run),
          annotations: run.pipelineAnnotations,
        });

        return { skipped: "not permitted" };
      }

      const result = await handler({
        event: ctx.event,
        events: ctx.events ?? [ctx.event],
        runId: ctx.runId,
        pipelineId: config.id,
        repo: run.repo,
        attempt: ctx.attempt ?? 0,
        logger: ctx.logger ?? console,
      });

      const skip = asSkip(result);

      if (skip) {
        countApi("skip");
      }

      await completeDeferredJobChecks(run, checks);

      await completePipeline(run, checks, {
        conclusion: "success",
        title: skip ? `Nothing to do: ${skip.reason}` : summaryTitle(run),
        summary: pipelineSummaryWithReports(run),
        annotations: run.pipelineAnnotations,
      });

      return result;
    } catch (error) {
      // A failed command's exit code is already recorded in its steps, and a
      // usage error is the same on every attempt, so retrying the run would
      // only replay the same failure.
      const deterministic = isDeterministicFailure(error);

      retrying = !deterministic && run.willRetry(error);

      if (retrying) {
        // The check steps are memoized, so completing a check as failed now
        // would leave it failed even if the retry passes. They stay in
        // progress until an attempt that's final.
        const title = `Retrying (attempt ${run.attempt + 2} of ${run.maxAttempts})`;

        for (const [jobPath, deferred] of run.deferredChecks) {
          await checks.retrying({
            run,
            jobPath,
            ...(deferred.name ? { name: deferred.name } : {}),
            title,
          });
        }

        await checks.retrying({ run, title });

        throw error;
      }

      await completeDeferredJobChecks(run, checks);

      // Jobs that were still running when the run ended would otherwise leave
      // their checks spinning.
      await closeOpenJobChecks(run, checks);

      await completePipeline(run, checks, {
        conclusion: conclusionForError(error),
        title: errorTitle(error, run),
        summary: pipelineSummaryWithReports(run),
        annotations: run.pipelineAnnotations,
      });

      if (deterministic) {
        throw new NonRetriableError(error.message, { cause: error });
      }

      throw error;
    } finally {
      if (!retrying) {
        await destroyRunMachines(run, ctx.attempt ?? 0);
      }
    }
  });
};

/**
 * Complete the pipeline's check, with the run's closing metadata on its step,
 * or on a step of its own when checks are off.
 */
const completePipeline = async (
  run: CiRunScope,
  checks: CheckReporter,
  result: Omit<
    Parameters<CheckReporter["pipelineComplete"]>[0],
    "run" | "metadata"
  >,
): Promise<void> => {
  const metadata = () => {
    return runEndMetadata(run, result.conclusion);
  };

  await checks.pipelineComplete({ run, ...result, metadata });

  if (!run.checkName) {
    await metadataStep(run, "ci › metadata:end", metadata);
  }
};

/**
 * Look up the configured repository's default branch and its head commit, in a
 * step so every replay sees the same commit.
 *
 * With no GitHub credentials, as with the console reporter in dev, there's
 * nothing to ask, so the repository comes back without a commit.
 */
const resolveConfiguredRepo = (
  run: CiRunScope,
  fullName: string,
): Promise<RepoContext> => {
  const { owner, name } = parseRepo(fullName);

  return run.step.run(
    { id: `github › repo:resolve`, name: "repo:resolve" },
    async (): Promise<RepoContext> => {
      const base: RepoContext = { owner, name, fullName, sha: "" };
      const provider = run.ci.github as GitHubProvider;

      if (provider.kind === "console") {
        return base;
      }

      const octokit = await provider.octokit({ owner, repo: name });
      const { data: info } = await octokit.rest.repos.get({
        owner,
        repo: name,
      });
      const branch = info.default_branch;

      const { data: head } = await octokit.rest.repos.getBranch({
        owner,
        repo: name,
        branch,
      });

      return {
        ...base,
        sha: head.commit.sha,
        ref: `refs/heads/${branch}`,
        baseRef: branch,
        trigger: (run.event as { name?: string } | undefined)?.name ?? "manual",
      };
    },
  ) as Promise<RepoContext>;
};

/**
 * Look up a pull request's head and base, in a step so every replay sees the
 * same commit.
 *
 * With no GitHub credentials, as with the console reporter in dev, there's
 * nothing to ask, so the repository comes back unchanged.
 */
const resolvePullRequestHead = (
  run: CiRunScope,
  repo: RepoContext,
): Promise<RepoContext> => {
  return run.step.run(
    { id: `github › pr:resolve`, name: "pr:resolve" },
    async (): Promise<RepoContext> => {
      const provider = run.ci.github as GitHubProvider;
      const number = repo.pullRequest?.number;

      if (provider.kind === "console" || !number) {
        return repo;
      }

      const octokit = await provider.octokit({
        owner: repo.owner,
        repo: repo.name,
      });
      const { data: pr } = await octokit.rest.pulls.get({
        owner: repo.owner,
        repo: repo.name,
        pull_number: number,
      });

      return {
        ...repo,
        sha: pr.head.sha,
        ref: pr.head.ref,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        pullRequest: {
          number,
          headRef: pr.head.ref,
          fork: (pr.head.repo?.full_name ?? repo.fullName) !== repo.fullName,
        },
      };
    },
  ) as Promise<RepoContext>;
};

/** Errors that replaying the run would only reproduce. */
const isDeterministicFailure = (error: unknown): error is Error => {
  // A matrix with `failFast` off rejects with every combination's error.
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 &&
      error.errors.every((inner) => {
        return isDeterministicFailure(inner);
      })
    );
  }

  return (
    error instanceof CommandFailedError ||
    error instanceof CommandTimeoutError ||
    error instanceof CiUsageError
  );
};

/**
 * Whether the error is a `NonRetriableError`. A step's error comes back into
 * the handler as a `StepError` that only carries the name, so `instanceof`
 * alone misses a non-retriable step failure, and the run would wait for a
 * retry that never comes, leaving its checks open.
 */
const isNonRetriable = (error: unknown): boolean => {
  return (
    error instanceof NonRetriableError ||
    (error as { name?: unknown } | undefined)?.name === "NonRetriableError"
  );
};

/**
 * Whether Inngest will run the function again after this error: it isn't
 * non-retriable and attempts remain.
 */
const willRetry = (
  error: unknown,
  attempt: number,
  maxAttempts: number,
): boolean => {
  if (isNonRetriable(error) || isDeterministicFailure(error)) {
    return false;
  }

  return attempt < maxAttempts - 1;
};

/** How many times Inngest retries a function that sets no `retries`. */
const defaultRetries = 4;

/**
 * Complete the job checks that were held back for a retry that isn't coming
 * after all: the run succeeded around the failed job, or this was the last
 * attempt.
 */
const completeDeferredJobChecks = async (
  run: CiRunScope,
  checks: CheckReporter,
): Promise<void> => {
  const deferred = [...run.deferredChecks.entries()];

  run.deferredChecks.clear();

  for (const [jobPath, { name, ...result }] of deferred) {
    await checks.jobComplete({
      run,
      jobPath,
      ...(name ? { name } : {}),
      ...result,
    });
  }
};

/**
 * Complete the job checks of anything still running when the run ended.
 *
 * With `Promise.all`, the first failure ends the run while its siblings are
 * mid-flight; their checks are marked cancelled rather than left in progress.
 */
const closeOpenJobChecks = async (
  run: CiRunScope,
  checks: CheckReporter,
): Promise<void> => {
  const open = [...run.openChecks.entries()];

  run.openChecks.clear();

  for (const [jobPath, name] of open) {
    run.summaries.push({
      path: jobPath,
      conclusion: "cancelled",
      title: "Cancelled: the pipeline ended first",
      durationMs: 0,
    });

    await checks.jobComplete({
      run,
      jobPath,
      ...(name ? { name } : {}),
      conclusion: "cancelled",
      title: "Cancelled: the pipeline ended first",
    });
  }
};

const pipelineSummaryWithReports = (run: CiRunScope): string => {
  return [pipelineSummary(run), ...run.pipelineSummaries].join("\n\n");
};

const summaryTitle = (run: CiRunScope): string => {
  const failed = run.summaries.filter((summary) => {
    return summary.conclusion !== "success";
  });

  if (failed.length > 0) {
    return `${failed
      .map((summary) => {
        return summary.path;
      })
      .join(", ")} failed`;
  }

  const total = run.summaries.reduce((sum, summary) => {
    return sum + summary.durationMs;
  }, 0);

  return run.summaries.length === 0
    ? "Nothing to do"
    : `${run.summaries.length} job${run.summaries.length === 1 ? "" : "s"} passed in ${formatDuration(total)}`;
};

const errorTitle = (error: unknown, run: CiRunScope): string => {
  const failed = run.summaries.find((summary) => {
    return summary.conclusion !== "success";
  });

  if (failed) {
    return `${failed.path}: ${failed.title}`;
  }

  return error instanceof Error
    ? (error.message.split("\n")[0] ?? "Failed")
    : "Failed";
};

const asSkip = (result: unknown): CiSkip | undefined => {
  return (result as CiSkip | undefined)?.kind === "inngest/ci.skip"
    ? (result as CiSkip)
    : undefined;
};

/**
 * Comment triggers can't express a permission check in CEL, so it happens here
 * and reports "Not permitted" rather than failing.
 */
const checkCommentPermission = async (
  run: CiRunScope,
  config: PipelineConfig,
): Promise<boolean> => {
  const event = run.event as { name?: string } | undefined;

  if (!event?.name?.startsWith("github/issue_comment")) {
    return true;
  }

  const minPermission = permissionForComment(
    config,
    commentBody(run.event as { data?: unknown }),
  );

  if (!minPermission) {
    return true;
  }

  const login = commentAuthor(run.event as { data?: unknown });

  if (!login) {
    return false;
  }

  const allowed = await canUser(login, minPermission);

  if (!allowed) {
    await run.step.run(
      { id: "github › comment:denied", name: "comment:denied" },
      async () => {
        const { stickyComment } = await import("../github/helpers.ts");

        await stickyComment(
          "permission",
          `@${login} you need \`${minPermission}\` permission to run \`${commentBody(run.event as { data?: unknown }).split(" ")[0]}\`.`,
        );

        return { denied: login };
      },
    );
  }

  return allowed;
};

/**
 * The permission of the command a comment starts with. When commands overlap,
 * like `/test` and `/test-all`, the longest one is the command that was meant.
 */
const permissionForComment = (
  config: PipelineConfig,
  body: string,
): Permission | undefined => {
  const matched = (config.commentPermissions ?? [])
    .filter(({ command }) => {
      return body.startsWith(command);
    })
    .sort((a, b) => {
      return b.command.length - a.command.length;
    });

  return matched[0]?.minPermission;
};

/**
 * Destroys the machines of a run of `config.id` that ended permanently, by
 * failure or cancellation, without reaching its own cleanup step.
 */
export const cleanupFunction = ({
  client,
  config,
}: {
  client: Inngest.Any;
  config: Pick<PipelineConfig, "id">;
}): InngestFunction.Any => {
  return client.createFunction(
    {
      id: `${config.id}/cleanup`,
      triggers: [
        {
          event: internalEvents.FunctionFailed,
          if: `event.data.function_id == "${client.id}-${config.id}"`,
        },
        {
          event: internalEvents.FunctionCancelled,
          if: `event.data.function_id == "${client.id}-${config.id}"`,
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
    async ({ event, step }: any) => {
      const runId = event?.data?.run_id ?? event?.data?.runId;

      return step.run("destroy-orphans", async () => {
        return runId ? destroyOrphans(client, runId) : { destroyed: 0 };
      });
    },
  );
};

/**
 * The functions a pipeline needs behind the scenes: cleanup after a permanent
 * failure or cancellation, and re-runs from a GitHub check.
 */
const generatedFunctions = ({
  client,
  config,
}: {
  client: Inngest.Any;
  config: PipelineConfig;
}): InngestFunction.Any[] => {
  const functions: InngestFunction.Any[] = [
    cleanupFunction({ client, config }),
  ];

  functions.push(
    client.createFunction(
      {
        id: `${config.id}/check-rerequested`,
        triggers: [
          { event: "github/check_run.rerequested" },
          { event: "github/check_suite.rerequested" },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
      async ({ event, step }: any) => {
        const { rerunEventFor } = await import("./rerun.ts");

        return rerunEventFor({ event, step, client, config });
      },
    ),
  );

  return functions;
};

/**
 * A run that ended permanently never reached its own cleanup step, so its
 * machines are found by name. Listing has no name filter, so the comparison
 * happens here.
 */
export const destroyOrphans = async (
  client: Inngest.Any,
  runId: string,
): Promise<{ destroyed: number }> => {
  const prefix = `ci-${runId}-`;
  let cursor: string | undefined;
  let destroyed = 0;

  do {
    const page = await client.sandboxes.list({
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });

    for (const sandbox of page.items) {
      if (sandbox.name.startsWith(prefix)) {
        try {
          await sandbox.destroy();

          destroyed++;
        } catch (error) {
          // Anything but "not found" fails the step so it retries.
          if (!isSandboxNotFound(error)) {
            throw error;
          }
        }
      }
    }

    cursor = page.page.hasMore ? page.page.cursor : undefined;
  } while (cursor);

  return { destroyed };
};

/**
 * One function per cached job with `refresh` triggers, so the cache is built
 * ahead of time rather than by whichever pull request gets there first.
 *
 * These are built when `ci.functions()` is called, because a job may be
 * registered after the pipelines that use it, and because a job used by
 * several pipelines still only needs one refresh function.
 */
export const cacheRefreshFunctions = ({
  client,
  internals,
  jobs,
  repo,
}: {
  client: Inngest.Any;
  internals: CiInternals;
  jobs: Map<string, RegisteredJob>;
  repo?: string;
}): InngestFunction.Any[] => {
  const functions: InngestFunction.Any[] = [];

  for (const job of jobs.values()) {
    const refresh = job.config.cache?.refresh;

    if (!refresh || refresh.length === 0) {
      continue;
    }

    const id = `ci/cache-refresh/${job.id}`;

    functions.push(
      client.createFunction(
        {
          id,
          triggers: refresh,
          singleton: { key: `"${job.id}"`, mode: "skip" },
          middleware: [sandboxMiddleware(), metadataMiddleware()],
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
        async (ctx: any) => {
          return runPipeline({
            internals,
            config: {
              id,
              on: refresh,
              check: false,
              ...(repo ? { repo } : {}),
            },
            handler: async () => {
              return runJob({
                config: job.config,
                handler: job.handler,
                input: undefined,
              });
            },
            ctx,
          });
        },
      ),
    );
  }

  return functions;
};
