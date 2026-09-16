import type { StandardSchemaV1 } from "@standard-schema/spec";

import { internalEvents } from "../../helpers/consts.ts";
import { getAsyncCtx } from "../execution/als.ts";
import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { sandboxMiddleware } from "../sandbox/middleware.ts";
import type { DurableSandboxTools } from "../sandbox/types.ts";
import {
  lookupCache,
  memoryCacheStore,
  snapshotIsReady,
  storeCache,
} from "./cache.ts";
import {
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "./errors.ts";
import type { ConsoleProvider, GitHubProvider } from "./github/auth.ts";
import { consoleReporter } from "./github/auth.ts";
import type { CheckReporter, CheckSink } from "./github/checks.ts";
import {
  checksSink,
  consoleSink,
  createCheckReporter,
  noopSink,
  pipelineSummary,
  statusesSink,
} from "./github/checks.ts";
import {
  commentAuthor,
  commentBody,
  repoContextFromEvent,
} from "./github/events.ts";
import { canUser } from "./github/helpers.ts";
import { setFallbackGitHub } from "./github/rest.ts";
import type { Permission } from "./github/triggers.ts";
import { destroyRunMachines, pauseMachine, snapshotJob } from "./machine.ts";
import type { CiInternals, CiJobScope, CiRunScope } from "./scope.ts";
import {
  getJobScope,
  initCiAls,
  runInScope,
  runJobBody,
  scopeSeparator,
} from "./scope.ts";
import type {
  AnyJob,
  CacheEntry,
  CheckConclusion,
  CiSkip,
  CiTrigger,
  Job,
  JobConfig,
  MachineConfig,
  Matrix,
  MatrixCombo,
  MatrixConfig,
  PipelineConfig,
  PipelineContext,
  RepoContext,
} from "./types.ts";
import { formatDuration, formatRelative } from "./util.ts";

export interface CiOptions {
  /**
   * How pipelines talk to GitHub. Defaults to a console reporter in dev, and
   * to no reporting otherwise.
   */
  github?: GitHubProvider;
  /** Where cache entries are stored. Defaults to `memoryCacheStore()` in dev. */
  cacheStore?: {
    get(key: string): Promise<CacheEntry | undefined>;
    set(key: string, entry: CacheEntry): Promise<void>;
  };
  /** Default machine for jobs. */
  machine?: MachineConfig;
  /** Builds the link shown on checks. */
  runUrl?: (ctx: { runId: string; functionId: string }) => string;
}

export interface Ci {
  pipeline(
    config: PipelineConfig,
    handler: (ctx: PipelineContext) => Promise<unknown>,
  ): InngestFunction.Any;

  job<TResult>(
    idOrConfig: string | JobConfig,
    handler: () => Promise<TResult>,
  ): Job<TResult>;
  job<TInput, TResult>(
    idOrConfig: string | JobConfig<TInput>,
    handler: (input: TInput) => Promise<TResult>,
  ): Job<TResult, TInput>;

  matrix<TAxes extends Record<string, readonly unknown[]>, TResult>(
    config: MatrixConfig<TAxes>,
    handler: (combo: MatrixCombo<TAxes>) => Promise<TResult>,
  ): Matrix<TAxes, TResult>;

  /** Manual trigger with a typed payload. Sends `ci/manual.<pipelineId>`. */
  manual<TSchema extends StandardSchemaV1>(opts: {
    schema: TSchema;
    pipelineId?: string;
  }): CiTrigger;

  /** End a pipeline early, with a reason shown on the check. */
  skip(reason: string): CiSkip;

  /**
   * Every function to pass to `serve()`: pipelines, cleanup, cache refreshes,
   * and re-run handling.
   */
  functions(): InngestFunction.Any[];
}

interface RegisteredJob {
  id: string;
  config: JobConfig;
  // biome-ignore lint/suspicious/noExplicitAny: user handler
  handler: (input: any) => Promise<any>;
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Create a CI client from an Inngest client.
 *
 * ```ts
 * export const ci = createCi(inngest, {
 *   github: githubApp({ appId, privateKey }),
 * });
 * ```
 */
export const createCi = (client: Inngest.Any, options: CiOptions = {}): Ci => {
  const isDev = Boolean(
    (client as unknown as { mode?: { isDev?: boolean } }).mode?.isDev,
  );

  const provider = resolveProvider(options.github, isDev);
  const internals: CiInternals = {
    client,
    isDev,
    github: provider,
    checks: createCheckReporter(sinkFor(provider, client)),
    cacheStore: options.cacheStore ?? memoryCacheStore(),
    ...(options.machine ? { defaultMachine: options.machine } : {}),
    runUrl: options.runUrl ?? defaultRunUrl(client, isDev),
    logger: (
      client as unknown as { logger?: { warn: (...args: unknown[]) => void } }
    ).logger,
  };

  setFallbackGitHub(provider);

  const jobs = new Map<string, RegisteredJob>();
  const generated: InngestFunction.Any[] = [];
  const pipelines: InngestFunction.Any[] = [];

  const ci: Ci = {
    pipeline: (config, handler) => {
      const triggers = flattenTriggers(config.on);

      if (triggers.length === 0) {
        throw new CiUsageError(
          `Pipeline "${config.id}" has no triggers. Pass \`on: github.pullRequest()\`, a cron, or \`ci.manual({ schema })\`.`,
        );
      }

      const fn = client.createFunction(
        {
          ...flowControl(config),
          id: config.id,
          triggers,
          middleware: [sandboxMiddleware()],
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
        async (ctx: any) =>
          runPipeline({ internals, config, handler, ctx, jobs }),
      );

      pipelines.push(fn);
      generated.push(
        ...generatedFunctions({ client, internals, config, jobs }),
      );

      return fn;
    },

    // biome-ignore lint/suspicious/noExplicitAny: overloaded signature
    job: ((idOrConfig: any, handler: any) => {
      const config: JobConfig =
        typeof idOrConfig === "string" ? { id: idOrConfig } : idOrConfig;

      // Curried job factories build a new job object per call, so the same ID
      // being registered again is expected.
      jobs.set(config.id, { id: config.id, config, handler });

      const job = ((input: unknown) =>
        runJob({ internals, config, handler, input })) as AnyJob;

      Object.defineProperties(job, {
        id: { value: config.id, enumerable: true },
        kind: { value: "inngest/ci.job", enumerable: true },
      });

      return job;
      // biome-ignore lint/suspicious/noExplicitAny: overloaded signature
    }) as any,

    matrix: (config, handler) => createMatrix(ci, config, handler),

    manual: (opts) => ({
      event: `ci/manual.${opts.pipelineId ?? "*"}`,
      ...(opts.schema ? { schema: opts.schema } : {}),
    }),

    skip: (reason) => ({ kind: "inngest/ci.skip", reason }),

    functions: () => [...pipelines, ...generated],
  };

  return ci;
};

const flattenTriggers = (on: CiTrigger | CiTrigger[]): CiTrigger[] =>
  (Array.isArray(on) ? on.flat(Infinity) : [on]) as CiTrigger[];

const flowControl = (config: PipelineConfig) => {
  const {
    id: _id,
    on: _on,
    check: _check,
    machine: _machine,
    repo: _repo,
    ...rest
  } = config;
  return rest;
};

const resolveProvider = (
  provider: GitHubProvider | undefined,
  isDev: boolean,
): GitHubProvider => {
  // In dev, checks print to the terminal unless the run is explicitly told to
  // talk to GitHub.
  if (isDev && process.env.INNGEST_CI_GITHUB !== "live") {
    return provider && provider.kind === "console"
      ? provider
      : consoleReporter();
  }

  return provider ?? consoleReporter();
};

const sinkFor = (provider: GitHubProvider, client: Inngest.Any): CheckSink => {
  switch (provider.reporter) {
    case "checks":
      return checksSink(provider);
    case "statuses":
      return statusesSink(provider);
    case "console":
      return consoleSink(
        (
          client as unknown as {
            logger?: { info: (...args: unknown[]) => void };
          }
        ).logger,
        (provider as ConsoleProvider).history,
      );
    default:
      return noopSink;
  }
};

const defaultRunUrl =
  (client: Inngest.Any, isDev: boolean) =>
  ({ runId }: { runId: string; functionId: string }) => {
    if (isDev) {
      const base =
        process.env.INNGEST_DEV_SERVER_URL ??
        process.env.INNGEST_BASE_URL ??
        "http://localhost:8288";
      return `${base.replace(/\/$/, "")}/run?runID=${runId}`;
    }

    const env =
      process.env.INNGEST_ENV ??
      (client as unknown as { env?: string }).env ??
      "production";

    return `https://app.inngest.com/env/${env}/runs/${runId}`;
  };

interface RunPipelineArgs {
  internals: CiInternals;
  config: PipelineConfig;
  handler: (ctx: PipelineContext) => Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
  ctx: any;
  jobs: Map<string, RegisteredJob>;
}

/**
 * Run a pipeline: set up the run scope, report the pipeline check, run the
 * handler, then always complete the check and destroy the machines.
 */
const runPipeline = async ({
  internals,
  config,
  handler,
  ctx,
}: RunPipelineArgs): Promise<unknown> => {
  await initCiAls();

  const asyncCtx = await getAsyncCtx();
  if (!asyncCtx?.execution) {
    throw new CiUsageError(
      "A pipeline ran without an Inngest execution context. Pipelines must be served through `serve()` with `ci.functions()`.",
    );
  }

  const sandboxTools = (ctx.step as { sandbox?: DurableSandboxTools }).sandbox;

  const run: CiRunScope = {
    ci: internals,
    runId: ctx.runId,
    functionId: config.id,
    pipelineId: config.id,
    ...(config.check === false
      ? {}
      : { checkName: config.check?.name ?? config.id }),
    jobChecks: config.check === false ? false : config.check?.jobs !== false,
    event: ctx.event,
    ...(repoContextFromEvent(ctx.event)
      ? { repo: repoContextFromEvent(ctx.event) as RepoContext }
      : {}),
    jobs: new Map(),
    machines: new Map(),
    snapshots: new Map(),
    cacheEntries: new Map(),
    sandboxes: new Set(),
    summaries: [],
    step: ctx.step,
    sandboxTools: sandboxTools as DurableSandboxTools,
    asyncCtx,
    counters: new Map(),
    snapshotsUnavailable: false,
    warnings: [],
    pipelineSummaries: [],
    pipelineAnnotations: [],
  };

  const checks = internals.checks as CheckReporter;
  const started = Date.now();

  return runInScope({ run }, async () => {
    await checks.pipelineStart({ run });

    try {
      const permitted = await checkCommentPermission(run, config);

      if (!permitted) {
        await checks.pipelineComplete({
          run,
          conclusion: "neutral",
          title: "Not permitted",
          summary: pipelineSummary(run),
        });
        return { skipped: "not permitted" };
      }

      const result = await handler({
        event: ctx.event,
        runId: ctx.runId,
        repo: run.repo,
      });

      const skip = asSkip(result);

      await checks.pipelineComplete({
        run,
        conclusion: "success",
        title: skip ? `Nothing to do: ${skip.reason}` : summaryTitle(run),
        summary: pipelineSummaryWithReports(run),
      });

      return result;
    } catch (error) {
      await checks.pipelineComplete({
        run,
        conclusion: conclusionForError(error),
        title: errorTitle(error, run),
        summary: pipelineSummaryWithReports(run),
      });

      throw error;
    } finally {
      void started;
      await destroyRunMachines(run);
    }
  });
};

const pipelineSummaryWithReports = (run: CiRunScope): string =>
  [pipelineSummary(run), ...run.pipelineSummaries].join("\n\n");

const summaryTitle = (run: CiRunScope): string => {
  const failed = run.summaries.filter(
    (summary) => summary.conclusion !== "success",
  );

  if (failed.length > 0) {
    return `${failed.map((summary) => summary.path).join(", ")} failed`;
  }

  const total = run.summaries.reduce(
    (sum, summary) => sum + summary.durationMs,
    0,
  );

  return run.summaries.length === 0
    ? "Nothing to do"
    : `${run.summaries.length} job${run.summaries.length === 1 ? "" : "s"} passed in ${formatDuration(total)}`;
};

const conclusionForError = (error: unknown): CheckConclusion => {
  if (error instanceof CommandTimeoutError) {
    return "timed_out";
  }
  return "failure";
};

const errorTitle = (error: unknown, run: CiRunScope): string => {
  const failed = run.summaries.find(
    (summary) => summary.conclusion !== "success",
  );

  if (failed) {
    return `${failed.path}: ${failed.title}`;
  }

  return error instanceof Error
    ? (error.message.split("\n")[0] ?? "Failed")
    : "Failed";
};

const asSkip = (result: unknown): CiSkip | undefined =>
  (result as CiSkip | undefined)?.kind === "inngest/ci.skip"
    ? (result as CiSkip)
    : undefined;

/**
 * Comment triggers can't express a permission check in CEL, so it happens here
 * and reports "Not permitted" rather than failing.
 */
const checkCommentPermission = async (
  run: CiRunScope,
  config: PipelineConfig,
): Promise<boolean> => {
  const minPermission = (config as { commentPermission?: Permission })
    .commentPermission;

  if (!minPermission) {
    return true;
  }

  const event = run.event as { name?: string } | undefined;
  if (!event?.name?.startsWith("github/issue_comment")) {
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
        const { stickyComment } = await import("./github/helpers.ts");
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

interface RunJobArgs {
  internals: CiInternals;
  config: JobConfig;
  // biome-ignore lint/suspicious/noExplicitAny: user handler
  handler: (input: any) => Promise<any>;
  input: unknown;
}

/**
 * Run a job, or join the run already in progress for this ID.
 */
const runJob = async ({
  config,
  handler,
  input,
}: RunJobArgs): Promise<unknown> => {
  const { getRunScope } = await import("./scope.ts");
  const run = getRunScope();

  if (!run) {
    throw new CiUsageError(
      `Jobs can only run inside a pipeline. \`${config.id}\` was called outside \`ci.pipeline()\`.`,
    );
  }

  const existing = run.jobs.get(config.id);
  if (existing) {
    return existing;
  }

  const started = jobBody({ run, config, handler, input });
  run.jobs.set(config.id, started);

  return started;
};

const jobBody = async ({
  run,
  config,
  handler,
  input,
}: {
  run: CiRunScope;
  config: JobConfig;
  // biome-ignore lint/suspicious/noExplicitAny: user handler
  handler: (input: any) => Promise<any>;
  input: unknown;
}): Promise<unknown> => {
  const checks = run.ci.checks as CheckReporter;
  const scope: CiJobScope = {
    run,
    path: config.id,
    jobPath: config.id,
    config,
    fromCalled: false,
    fromJobIds: [],
    annotations: [],
    summaries: [],
    checkStarted: false,
    env: {},
    secrets: [],
  };

  const startedAt = Date.now();
  const jobCheckName = config.check === false ? undefined : config.check?.name;
  const jobChecksOn = config.check !== false;

  const cacheLookup = config.cache
    ? await lookupCache(scope, config.cache, {})
    : undefined;

  // A hit with a usable snapshot means the job doesn't run at all, and jobs
  // that start from it clone the saved machine.
  if (cacheLookup?.entry) {
    const entry = cacheLookup.entry;
    const usable = entry.snapshotId
      ? await snapshotIsReady(run, scope.path, entry.snapshotId)
      : true;

    if (usable) {
      run.cacheEntries.set(config.id, entry);

      if (entry.snapshotId) {
        run.snapshots.set(config.id, Promise.resolve(entry.snapshotId));
      }

      const title = entry.snapshotId
        ? `Restored, built ${formatRelative(entry.builtAt)} by ${entry.builtBy.trigger}`
        : `Passed at ${(entry.builtBy.sha ?? "").slice(0, 7)}, no changes since`;

      run.summaries.push({
        path: scope.path,
        conclusion: "success",
        title,
        durationMs: 0,
        cached: true,
      });

      if (jobChecksOn) {
        await checks.jobStart({
          run,
          jobPath: scope.path,
          ...(jobCheckName ? { name: jobCheckName } : {}),
        });
        await checks.jobComplete({
          run,
          jobPath: scope.path,
          ...(jobCheckName ? { name: jobCheckName } : {}),
          conclusion: "success",
          title,
        });
      }

      return entry.result;
    }
  }

  if (jobChecksOn) {
    await checks.jobStart({
      run,
      jobPath: scope.path,
      ...(jobCheckName ? { name: jobCheckName } : {}),
    });
  }

  try {
    const result = await runJobBody(scope, () => handler(input));
    const durationMs = Date.now() - startedAt;
    const title = `Passed in ${formatDuration(durationMs)}`;

    if (cacheLookup) {
      const snapshotId = scope.machine
        ? await snapshotJob(run, scope.path)
        : undefined;

      await storeCache(scope, cacheLookup, {
        jobId: config.id,
        ...(snapshotId ? { snapshotId } : {}),
        result,
        builtAt: new Date().toISOString(),
        builtBy: {
          runId: run.runId,
          ...(run.repo?.sha ? { sha: run.repo.sha } : {}),
          trigger: (run.event as { name?: string })?.name ?? "manual",
        },
        ...(scope.fromJobIds.length > 0
          ? { fromJobIds: scope.fromJobIds }
          : {}),
      });
    }

    run.summaries.push({
      path: scope.path,
      conclusion: "success",
      title,
      durationMs,
    });

    if (jobChecksOn) {
      await checks.jobComplete({
        run,
        jobPath: scope.path,
        ...(jobCheckName ? { name: jobCheckName } : {}),
        conclusion: "success",
        title,
        ...(scope.summaries.length > 0
          ? { summary: scope.summaries.join("\n\n") }
          : {}),
        ...(scope.annotations.length > 0
          ? { annotations: scope.annotations }
          : {}),
      });
    }

    await pauseMachine(scope);

    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const conclusion = conclusionForError(error);
    const title = jobErrorTitle(error);

    const keptSnapshotId =
      config.keepOnFailure && scope.machine
        ? await snapshotJob(run, scope.path)
        : undefined;

    run.summaries.push({
      path: scope.path,
      conclusion,
      title,
      durationMs,
      ...(keptSnapshotId ? { keptSnapshotId } : {}),
    });

    if (jobChecksOn) {
      await checks.jobComplete({
        run,
        jobPath: scope.path,
        ...(jobCheckName ? { name: jobCheckName } : {}),
        conclusion,
        title,
        summary: jobFailureSummary(error, scope),
        ...(scope.annotations.length > 0
          ? { annotations: scope.annotations }
          : {}),
      });
    }

    throw error;
  }
};

const jobErrorTitle = (error: unknown): string => {
  if (error instanceof CommandFailedError) {
    return `\`${error.command.join(" ")}\` exited with ${error.exitCode}`;
  }

  if (error instanceof CommandTimeoutError) {
    return `\`${error.command.join(" ")}\` timed out after ${error.timeout}`;
  }

  return error instanceof Error
    ? (error.message.split("\n")[0] ?? "Failed")
    : "Failed";
};

const jobFailureSummary = (error: unknown, scope: CiJobScope): string => {
  const parts: string[] = [];

  if (error instanceof CommandFailedError) {
    const output = `${error.stdoutTail}\n${error.stderrTail}`
      .split("\n")
      .slice(-60)
      .join("\n");

    parts.push(`\`\`\`\n${output}\n\`\`\``);
  } else if (error instanceof Error) {
    parts.push(error.message);
  }

  parts.push(
    `[View the trace](${scope.run.ci.runUrl({
      runId: scope.run.runId,
      functionId: scope.run.functionId,
    })})`,
  );

  return [...parts, ...scope.summaries].join("\n\n");
};

/**
 * Expand a matrix into its combinations and run them as jobs.
 */
const createMatrix = <
  TAxes extends Record<string, readonly unknown[]>,
  TResult,
>(
  ci: Ci,
  config: MatrixConfig<TAxes>,
  handler: (combo: MatrixCombo<TAxes>) => Promise<TResult>,
): Matrix<TAxes, TResult> => {
  const matrix = (async (only?: Partial<MatrixCombo<TAxes>>) => {
    const combos = expandMatrix(config).filter((combo) =>
      only
        ? Object.entries(only).every(
            ([key, value]) => combo[key as keyof MatrixCombo<TAxes>] === value,
          )
        : true,
    );

    const tasks = combos.map((combo) => async () => {
      const machine =
        typeof config.machine === "function"
          ? config.machine(combo)
          : config.machine;
      const cache =
        typeof config.cache === "function" ? config.cache(combo) : config.cache;

      const job = ci.job<TResult>(
        {
          id: matrixJobId(config.id, combo),
          ...(machine ? { machine } : {}),
          ...(cache ? { cache } : {}),
          ...(config.check === undefined ? {} : { check: config.check }),
        },
        () => handler(combo),
      );

      return job();
    });

    return runPool(tasks, config.concurrency, config.failFast ?? false);
  }) as Matrix<TAxes, TResult>;

  Object.defineProperty(matrix, "id", { value: config.id, enumerable: true });

  return matrix;
};

export const matrixJobId = (
  id: string,
  combo: Record<string, unknown>,
): string =>
  `${id} (${Object.entries(combo)
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(", ")})`;

/**
 * Every combination of the axes, in declaration order, with `exclude` removed
 * and `include` appended.
 */
export const expandMatrix = <TAxes extends Record<string, readonly unknown[]>>(
  config: MatrixConfig<TAxes>,
): MatrixCombo<TAxes>[] => {
  const keys = Object.keys(config.axes);

  let combos: Record<string, unknown>[] = [{}];

  for (const key of keys) {
    const values = config.axes[key] ?? [];
    combos = combos.flatMap((combo) =>
      values.map((value) => ({ ...combo, [key]: value })),
    );
  }

  const excluded = combos.filter(
    (combo) =>
      !(config.exclude ?? []).some((exclusion) =>
        Object.entries(exclusion).every(([key, value]) => combo[key] === value),
      ),
  );

  return [
    ...excluded,
    ...((config.include ?? []) as Record<string, unknown>[]),
  ] as MatrixCombo<TAxes>[];
};

/**
 * Run tasks with an optional in-flight limit.
 *
 * With `failFast` off, everything runs and the failures are thrown together,
 * so one bad combination doesn't hide the rest. With it on, the first failure
 * rejects; the others keep running and their results are ignored.
 */
export const runPool = async <T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number | undefined,
  failFast: boolean,
): Promise<T[]> => {
  const limit = concurrency && concurrency > 0 ? concurrency : tasks.length;
  const results: T[] = new Array(tasks.length);
  const errors: unknown[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      if (!task) {
        continue;
      }

      try {
        results[index] = await task();
      } catch (error) {
        if (failFast) {
          throw error;
        }
        errors.push(error);
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
    worker(),
  );

  await Promise.all(workers);

  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} job(s) failed`);
  }

  return results;
};

/**
 * The functions a pipeline needs behind the scenes: cleanup after a permanent
 * failure or cancellation, cache refreshes, and re-runs from GitHub.
 */
const generatedFunctions = ({
  client,
  internals,
  config,
  jobs,
}: {
  client: Inngest.Any;
  internals: CiInternals;
  config: PipelineConfig;
  jobs: Map<string, RegisteredJob>;
}): InngestFunction.Any[] => {
  const functions: InngestFunction.Any[] = [];

  functions.push(
    client.createFunction(
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

        // A run that ended permanently never reached its own cleanup step, so
        // its machines are found by name. Listing has no name filter, so the
        // comparison happens here.
        return step.run("destroy-orphans", async () => {
          if (!runId) {
            return { destroyed: 0 };
          }

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
                } catch {
                  // Already gone.
                }
              }
            }

            cursor = page.page.hasMore ? page.page.cursor : undefined;
          } while (cursor);

          return { destroyed };
        });
      },
    ),
  );

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

  for (const job of jobs.values()) {
    const refresh = job.config.cache?.refresh;
    if (!refresh || refresh.length === 0) {
      continue;
    }

    functions.push(
      client.createFunction(
        {
          id: `ci/cache-refresh/${job.id}`,
          triggers: refresh,
          singleton: { key: `"${job.id}"`, mode: "skip" },
          middleware: [sandboxMiddleware()],
        },
        // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
        async (ctx: any) =>
          runPipeline({
            internals,
            config: {
              id: `ci/cache-refresh/${job.id}`,
              on: refresh,
              check: false,
              ...(config.repo ? { repo: config.repo } : {}),
            },
            handler: async () => {
              const registered = jobs.get(job.id);
              if (!registered) {
                return null;
              }
              return jobBodyForRefresh(registered);
            },
            ctx,
            jobs,
          }),
      ),
    );
  }

  return functions;
};

/**
 * A refresh run calls the job the same way a pipeline would, so `from()` and
 * dedupe behave identically.
 */
const jobBodyForRefresh = async (job: RegisteredJob): Promise<unknown> => {
  const { getRunScope } = await import("./scope.ts");
  const run = getRunScope();

  if (!run) {
    return null;
  }

  return runJob({
    internals: run.ci,
    config: job.config,
    handler: job.handler,
    input: undefined,
  });
};

/**
 * The scope a job is currently running in, for helpers that need it.
 */
export const currentJobScope = (): CiJobScope | undefined => getJobScope();

export { scopeSeparator };
