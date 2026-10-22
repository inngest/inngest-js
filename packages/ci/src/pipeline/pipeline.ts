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
import { pipelineSummary, savedFromCache, wallTime } from "../github/checks.ts";
import {
  commentAuthor,
  commentBody,
  repoContextFromEvent,
} from "../github/events.ts";
import { canUser } from "../github/helpers.ts";
import { jobCheck } from "../github/render/job.ts";
import type { CheckAction, CheckPayload } from "../github/render/types.ts";
import { commentPermissionFor, type Permission } from "../github/triggers.ts";
import {
  deleteOrphanSnapshots,
  deleteRunSnapshots,
  destroyOrphans,
  destroyRunMachines,
  lockMachineName,
} from "../machine/machine.ts";
import type {
  CheckAnnotation,
  CheckConclusion,
  CiSkip,
  CiTrigger,
  CiTriggerInput,
  PipelineConfig,
  PipelineContext,
  RepoContext,
} from "../types.ts";
import { errorMessage, formatDuration, parseRepo } from "../util.ts";
import type { BuildDone } from "./buildLock.ts";
import { buildDoneEvent, endBuild } from "./buildLock.ts";
import type { CacheBuildData } from "./cacheBuild.ts";
import type { RegisteredJob } from "./job.ts";
import { conclusionForError, runJob } from "./job.ts";
import { runLinks } from "./jobReport.ts";
import {
  ciRun,
  metadataStep,
  runEndMetadata,
  runStartMetadata,
} from "./metadata.ts";
import { stepOptions, steps } from "./names.ts";
import { markJob, pipelinePayload } from "./pipelineReport.ts";
import type { CiInternals, CiRunScope } from "./scope.ts";
import {
  apiNames,
  cacheRefreshIdPrefix,
  countApi,
  inGitHubSpan,
  initCiAls,
  requestOf,
  runInScope,
  withScopePreserved,
} from "./scope.ts";

/** Sent by a check's Cancel button, to end the runs of a pipeline for a commit. */
export const cancelRunEvent = "ci/run.cancel";

/**
 * Options for every function that runs a pipeline: pipelines, cache builds and
 * refreshes.
 *
 * With parallelism optimized, the executor waits for every step in a parallel
 * batch before it calls the function again, so a slow step in one job holds
 * back every other job. Turning it off has the executor call back after each
 * step, so jobs run independently. It's deprecated in favour of
 * `group.parallel({ mode: "race" })`, but that stops steps running inline and
 * added a 15-20s gap between a job's steps on a real run.
 *
 * It also lets a run register a `waitForEvent` beside a `step.run` (the build
 * lock's wait and look) without the executor holding the look until the wait
 * ends.
 */
export const pipelineFunctionOptions = { optimizeParallelism: false } as const;

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
      ...pipelineFunctionOptions,
      // The Cancel button on a check ends this pipeline's runs for the commit.
      // A trigger's commit is where its event keeps it.
      cancelOn: [
        {
          event: cancelRunEvent,
          if: `async.data.app == "${client.id}" && async.data.pipeline == "${config.id}" && async.data.repo == event.data.repository.full_name && (async.data.sha == event.data.pull_request.head.sha || async.data.sha == event.data.after || async.data.sha == event.data.merge_group.head_sha)`,
        },
      ],
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
    generated: generatedFunctions({ client, config, internals }),
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
    childRuns: _childRuns,
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
    childRuns: config.childRuns !== false,
    event: ctx.event,
    ...rerunOf(ctx.event),
    ...(repo ? { repo } : {}),
    ...(build ? { build, request: requestOf(build) } : {}),
    builds: new Map(),
    sources: new Map(
      Object.entries(build?.sources ?? {}).map(([key, source]) => {
        return [key, Promise.resolve(source)];
      }),
    ),
    matrixAxes: new Map(),
    definedJobs: new Set(),
    inlineJobs: new Map(),
    jobCalls: new Map(),
    createdSnapshots: new Set(),
    summaries: [],
    jobGraph: new Map(),
    openChecks: new Map(),
    cacheSaved: new Map(),
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

  // A re-run of one pipeline's check goes out as an event every pipeline on
  // the trigger hears. The others have nothing to re-run, and a run that did
  // nothing must not report success over the result they already have.
  const rerunPipeline = (
    ctx.event as { data?: { _ci?: { pipeline?: string } } } | undefined
  )?.data?._ci?.pipeline;

  if (!build && rerunPipeline !== undefined && rerunPipeline !== config.id) {
    return { skipped: "another pipeline's re-run" };
  }

  const run = newRunScope({
    internals,
    config,
    ctx,
    asyncCtx,
    ...(build ? { build, request: requestOf(build) } : {}),
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

    if (checkStarted !== undefined) {
      run.startedAt = checkStarted;
    }

    if (checkStarted === undefined) {
      await metadataStep(run, "ci › metadata:start", () => {
        return runStartMetadata(run);
      });
    }

    // The handler's outcome is caught here, so what comes after it is the same
    // steps whether it passed or failed. Which jobs were still running, what
    // the summaries say and which sandboxes exist all differ between
    // requests, so each is read inside the step that needs it, never to
    // decide which steps exist.
    const outcome = await settle({ run, config, handler, ctx });

    if (outcome.kind === "failed") {
      // A run that is about to be retried keeps its machines and snapshots:
      // the retry replays the memoized machine and snapshot IDs and needs them
      // alive. The generated cleanup function covers a run that never gets
      // here; it finds machines by name, but snapshots carry no run name, so
      // it can't delete them.
      if (
        !isDeterministicFailure(outcome.error) &&
        run.willRetry(outcome.error)
      ) {
        // The check steps are memoized, so completing a check as failed now
        // would leave it failed even if the retry passes. They stay in
        // progress until an attempt that's final.
        const title = `Retrying (attempt ${run.attempt + 2} of ${run.maxAttempts})`;

        await checks.retrying({ run, title });

        throw outcome.error;
      }
    }

    // Jobs that were still running when the run ended would otherwise leave
    // their checks spinning. The run doesn't wait for them: one a person left
    // unawaited on purpose is cancelled by the run ending.
    const cleanUp = async () => {
      await destroyRunMachines(run, ctx.attempt ?? 0);
      await deleteRunSnapshots(run, ctx.attempt ?? 0);

      // Last, so the runs it wakes find the lock free.
      await endBuild(run, outcome);
    };

    try {
      try {
        await closeJobChecks(run, checks);

        run.ci.hooks.warnings(run);
      } catch (error) {
        // However the run ended, its status says so, unless another attempt
        // will.
        if (!run.willRetry(error)) {
          await completePipeline(run, checks, outcome);
        }

        throw error;
      }

      await completePipeline(run, checks, outcome);
    } catch (error) {
      // Reporting failed. Another attempt replays the memoized machine and
      // snapshot IDs, so it keeps them; the last attempt cleans up anyway,
      // since the generated cleanup function can't find snapshots.
      if (!run.willRetry(error)) {
        await cleanUp();
      }

      throw error;
    }

    await cleanUp();

    if (outcome.kind === "failed") {
      // A failed command's exit code is already recorded in its steps, and a
      // usage error is the same on every attempt, so retrying the run would
      // only replay the same failure.
      if (isDeterministicFailure(outcome.error)) {
        throw new NonRetriableError(outcome.error.message, {
          cause: outcome.error,
        });
      }

      throw outcome.error;
    }

    return outcome.kind === "denied"
      ? { skipped: "not permitted" }
      : outcome.result;
  });
};

/** What a re-run from a GitHub check asked for, from its event's `_ci`. */
const rerunOf = (event: unknown): Pick<CiRunScope, "noCache"> => {
  const ci = (event as { data?: { _ci?: { noCache?: boolean } } })?.data?._ci;

  return ci?.noCache ? { noCache: true } : {};
};

/** How the handler ended, caught rather than thrown. */
type Outcome =
  | { kind: "ran"; result: unknown }
  | { kind: "denied" }
  | { kind: "failed"; error: unknown };

/**
 * Run the handler, and say how it ended instead of throwing, so a failed run
 * reaches the same end-of-run steps as one that passed.
 */
const settle = async ({
  run,
  config,
  handler,
  ctx,
}: {
  run: CiRunScope;
  config: PipelineConfig;
  handler: (ctx: PipelineContext) => Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
  ctx: any;
}): Promise<Outcome> => {
  try {
    const permitted = await checkCommentPermission(run, config);

    if (!permitted) {
      return { kind: "denied" };
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

    if (asSkip(result)) {
      countApi("skip");
    }

    return { kind: "ran", result };
  } catch (error) {
    return { kind: "failed", error };
  }
};

/** What the pipeline's check concludes for an outcome. */
const conclusionOf = (outcome: Outcome): CheckConclusion => {
  switch (outcome.kind) {
    case "ran": {
      return asSkip(outcome.result) ? "skipped" : "success";
    }

    case "denied": {
      return "neutral";
    }

    case "failed": {
      return conclusionForError(outcome.error);
    }
  }
};

/**
 * What the pipeline's check says for an outcome. It reads the run's summaries,
 * warnings and annotations, so it only runs inside the step that completes
 * the check.
 */
const describeOutcome = (
  run: CiRunScope,
  outcome: Outcome,
): {
  title: string;
  summary: string;
  text?: string;
  actions?: CheckAction[];
  annotations: CheckAnnotation[];
} => {
  switch (outcome.kind) {
    case "ran": {
      const skip = asSkip(outcome.result);

      if (skip) {
        return {
          title: `Nothing to do: ${skip.reason}`,
          summary: pipelineSummaryWithReports(run),
          annotations: run.pipelineAnnotations,
        };
      }

      return {
        ...withPipelineReports(
          run,
          pipelinePayload(run, "passed", pipelineNotes(run)),
        ),
        annotations: run.pipelineAnnotations,
      };
    }

    case "denied": {
      return {
        title: "Not permitted",
        summary: pipelineSummary(run),
        annotations: run.pipelineAnnotations,
      };
    }

    case "failed": {
      const jobFailed = [...run.jobGraph.values()].some((node) => {
        return node.state === "failed";
      });

      const payload = pipelinePayload(run, "failed", {
        ...pipelineNotes(run),
        ...(jobFailed
          ? {}
          : {
              error: {
                title: errorTitle(outcome.error, run),
                message: errorMessage(outcome.error).split("\n")[0] ?? "",
              },
            }),
      });

      return {
        ...withPipelineReports(run, payload),
        annotations: run.pipelineAnnotations,
      };
    }
  }
};

/**
 * Complete the pipeline's check, with the run's closing metadata on its step,
 * or on a step of its own when checks are off.
 */
const completePipeline = async (
  run: CiRunScope,
  checks: CheckReporter,
  outcome: Outcome,
): Promise<void> => {
  const metadata = () => {
    return runEndMetadata(run, conclusionOf(outcome));
  };

  await checks.pipelineComplete({
    run,
    metadata,
    result: () => {
      return {
        conclusion: conclusionOf(outcome),
        ...describeOutcome(run, outcome),
      };
    },
  });

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

  return inGitHubSpan(run, () => {
    return ciRun(
      run,
      steps.resolveRepository(),
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
          trigger:
            (run.event as { name?: string } | undefined)?.name ?? "manual",
        };
      },
    );
  });
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
  return ciRun(
    run,
    steps.resolvePullRequest(),
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
  );
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

const cancelledTitle = "🛑 Cancelled: the pipeline ended first";

/**
 * Complete the job checks the run leaves behind: those of jobs still running.
 *
 * With `Promise.all`, the first failure ends the run while its siblings are
 * mid-flight, so their checks are marked cancelled rather than left in
 * progress, and so are those of jobs left unawaited. The siblings keep going
 * while this runs, and how far each got differs between requests, so they
 * are read inside one memoized step.
 */
const closeJobChecks = async (
  run: CiRunScope,
  checks: CheckReporter,
): Promise<void> => {
  const closed = await checks.jobsComplete({
    run,
    jobs: () => {
      const open = [...run.openChecks.entries()].map(([jobPath, name]) => {
        const shown = jobCheck({
          ...runLinks(run),
          name: jobPath,
          state: { kind: "cancelled", reason: "the pipeline ended first" },
        });

        return {
          jobPath,
          ...(name ? { name } : {}),
          conclusion: "cancelled" as const,
          title: cancelledTitle,
          summary: shown.summary,
          actions: shown.actions,
        };
      });

      return open;
    },
  });

  for (const job of closed) {
    markJob(run, job.jobPath, { state: "stopped" });

    if (job.conclusion === "cancelled" && job.title === cancelledTitle) {
      run.summaries.push({
        path: job.jobPath,
        conclusion: "cancelled",
        title: cancelledTitle,
        durationMs: 0,
      });
    }
  }
};

/** What the run has to say beside its jobs: its warnings and kept machines. */
const pipelineNotes = (run: CiRunScope): { notes: string[] } => {
  return {
    notes: [
      ...run.warnings.map((warning) => {
        return `📝 ${warning}`;
      }),
      ...run.summaries
        .filter((summary) => {
          return summary.keptSnapshotId;
        })
        .map((summary) => {
          return `📌 \`${summary.path}\` kept as snapshot \`${summary.keptSnapshotId}\``;
        }),
    ],
  };
};

/** The payload, with what the pipeline's own code reported below it. */
const withPipelineReports = (run: CiRunScope, payload: CheckPayload) => {
  return {
    title: payload.title,
    summary: [payload.summary, ...run.pipelineSummaries].join("\n\n"),
    ...(payload.text === undefined ? {} : { text: payload.text }),
    actions: payload.actions,
  };
};

const pipelineSummaryWithReports = (run: CiRunScope): string => {
  return [pipelineSummary(run), ...run.pipelineSummaries].join("\n\n");
};

const failedJobsTitle = (run: CiRunScope): string | undefined => {
  const failed = run.summaries.filter((summary) => {
    return summary.conclusion !== "success";
  });

  return failed.length === 0
    ? undefined
    : `${failed.length} of ${run.summaries.length} job${run.summaries.length === 1 ? "" : "s"} failed`;
};

const errorTitle = (error: unknown, run: CiRunScope): string => {
  const count = failedJobsTitle(run);
  const first = run.summaries.find((summary) => {
    return summary.conclusion !== "success";
  });

  if (count && first) {
    return `${count}: ${first.path}: ${first.title}`;
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
    await inGitHubSpan(run, () => {
      return ciRun(run, steps.commentNotAllowed(), async () => {
        const { stickyComment } = await import("../github/helpers.ts");

        await stickyComment(
          "permission",
          `@${login} you need \`${minPermission}\` permission to run \`${commentBody(run.event as { data?: unknown }).split(" ")[0]}\`.`,
        );

        return { denied: login };
      });
    });
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
 * Destroys the machines and deletes the snapshots of a run of `config.id`
 * that ended permanently, by failure or cancellation, without reaching its own
 * cleanup step.
 */
export const cleanupFunction = ({
  client,
  config,
  internals,
}: {
  client: Inngest.Any;
  config: Pick<PipelineConfig, "id" | "check">;
  /** Given, a cancelled run's pipeline check is completed as cancelled. */
  internals?: CiInternals;
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

      // A build that others waited on took a lock on its cache entry, whose
      // name is worked out from the request it failed on.
      const request = event?.data?.event?.data;

      const lock =
        request?.locked === true && typeof request.cacheKey === "string"
          ? lockMachineName(request.cacheKey)
          : undefined;

      const destroyed = await step.run(
        stepOptions(steps.cleanUpEndedRun()),
        async () => {
          if (!runId) {
            return { destroyed: 0, lockReleased: false, deleted: 0 };
          }

          return {
            ...(await destroyOrphans(client, runId, lock)),
            ...(await deleteOrphanSnapshots(client, runId)),
          };
        },
      );

      // A cancelled run never reaches its own completion, so its check would
      // stay in progress. What it needs comes from the run's trigger event.
      const repo = repoContextFromEvent(event?.data?.event);
      const checkName =
        config.check === false ? undefined : (config.check?.name ?? config.id);

      if (
        internals &&
        runId &&
        event?.name === internalEvents.FunctionCancelled &&
        checkName &&
        repo?.sha
      ) {
        await step.run(stepOptions(steps.endCancelledCheck()), async () => {
          await (internals.checks as CheckReporter).runCancelled({
            run: { runId, checkName, repo },
          });

          return null;
        });
      }

      // The runs waiting on it would otherwise wait for a build that is gone.
      // A build that ended on its own already told them, and one that told them
      // must not be counted as failing twice.
      if (lock && destroyed.lockReleased) {
        await step.sendEvent("announce-lock-released", {
          name: buildDoneEvent,
          data: {
            name: lock,
            status: "failed",
            reason: "the build run ended before it finished",
          } satisfies BuildDone,
        });
      }

      return destroyed;
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
  internals,
}: {
  client: Inngest.Any;
  config: PipelineConfig;
  internals: CiInternals;
}): InngestFunction.Any[] => {
  const functions: InngestFunction.Any[] = [
    cleanupFunction({ client, config, internals }),
  ];

  functions.push(
    client.createFunction(
      {
        id: `${config.id}/check-rerequested`,
        triggers: [
          { event: "github/check_run.rerequested" },
          { event: "github/check_suite.rerequested" },
          { event: "github/check_run.requested_action" },
        ],
      },
      // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
      async ({ event, step }: any) => {
        const { isOurCheck, rerunEventFor, mayRerun } = await import(
          "./rerun.ts"
        );

        // A button anyone who can see the check could click, so it needs the
        // same permission as pushing to the repository.
        if (!(await mayRerun({ event, step }))) {
          return { rerun: false, reason: "not permitted" };
        }

        if (event?.data?.requested_action?.identifier === "cancel") {
          if (!isOurCheck(event, config)) {
            return { rerun: false, reason: "not this pipeline's check" };
          }

          await step.sendEvent("cancel", {
            name: cancelRunEvent,
            data: {
              app: client.id,
              pipeline: config.id,
              repo: event.data.repository?.full_name,
              sha: event.data.check_run?.head_sha,
            },
          });

          return { rerun: false, reason: "cancelled" };
        }

        return rerunEventFor({ event, step, client, config });
      },
    ),
  );

  return functions;
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

    const id = `${cacheRefreshIdPrefix}${job.id}`;

    functions.push(
      client.createFunction(
        {
          id,
          triggers: refresh,
          singleton: { key: `"${job.id}"`, mode: "skip" },
          ...pipelineFunctionOptions,
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
