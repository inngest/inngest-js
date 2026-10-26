/**
 * Building a job's snapshot in a run of its own: what a pipeline hands the
 * build, the one generated function that does it, and what it hands back.
 *
 * A pipeline asks for a build of a cached job, and of any job another job
 * starts `from`, instead of running the job inline. One function builds every
 * job: the data says which. A job that starts fresh is asked for by event, so
 * concurrent runs that miss the same entry build it once (see buildLock.ts);
 * the rest are invoked. It looks the snapshot up again when it starts, so a
 * request that arrives just after a build finished does not build again. Within
 * a pipeline run each base is built once. Across concurrent runs a job that
 * starts `from` another is best-effort: runs that miss at the same time may
 * build redundantly, at most one snapshot keeps the name and the others adopt
 * it, so every run gets a correct snapshot.
 *
 * @module
 */

import type { Inngest, InngestFunction } from "inngest";
import { internalEvents, NonRetriableError } from "inngest";
import { metadataMiddleware, sandboxMiddleware } from "inngest/experimental";
import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import { CommandFailedError, CommandTimeoutError } from "../errors.ts";
import type { ResolvedSource } from "../github/source.ts";
import { cycleMessage } from "../machine/from.ts";
import type {
  Ancestor,
  CheckAnnotation,
  MachineConfig,
  MatrixAxes,
  MatrixJob,
  RepoContext,
} from "../types.ts";
import { answerAppJob } from "./appJob.ts";
import { buildRequestedEvent } from "./buildLock.ts";
import type { RegisteredJob } from "./job.ts";
import { builtResult, runJob } from "./job.ts";
import { runCombosKey } from "./matrix.ts";
import { pipelineFunctionOptions, runPipeline } from "./pipeline.ts";
import type { CiInternals, CiRunScope, JobSummary } from "./scope.ts";
import { getRunScope, requestOf } from "./scope.ts";

/** The event every invoked function runs from. */
const invokedEvent = "inngest/function.invoked";

/**
 * What a pipeline sends to build one job's snapshot. It's everything the
 * build can't work out for itself, since it starts with no event of its own.
 */
export interface CacheBuildData extends Record<string, unknown> {
  /** The job's ID, which for a matrix combination includes the combination. */
  jobId: string;
  /** The matrix and combination to build, when the job is one of its jobs. */
  matrix?: { id: string; combo: Record<string, unknown> };
  /**
   * The job's input as the invoker was given it, before its schema, for jobs
   * that take one. It is JSON, so it is the build that validates it: a schema's
   * output may not be accepted by the schema a second time.
   */
  input?: unknown;
  /**
   * The job's resolved cache key, as the pipeline computed it. For a job
   * without a `cache`, its input's hash, if it has one.
   */
  ownKey: string;
  /**
   * The name the snapshot is written under: the shared cache's, a local run's
   * or the pipeline run's own, each with the job and `ownKey`.
   */
  cacheKey: string;
  /** The named parts of the job's `cache.key` as the invoking run resolved them. */
  key?: Record<string, string>;
  /**
   * The `app/job`s whose builds led to this one, outermost first. A build
   * asked for a job that is already here is a cycle.
   */
  chain?: string[];
  /**
   * Set when another app asks for this job with `image.job()`. It can't name
   * the job's snapshot, so this run works the name out itself.
   */
  askedByApp?: boolean;
  /**
   * A snapshot that turned out to be bad, which may still hold the name. The
   * build never reuses it.
   */
  exclude?: string;
  /** Whether `exclude` was decided to be broken, so the build may delete it. */
  broken?: boolean;
  /**
   * Take the snapshot without the name, because another build may still hold
   * it. The invoking run starts its jobs from it and deletes it at its end.
   */
  unnamed?: boolean;
  /**
   * Set on a request for a build that others may be waiting on, which answers
   * with `ci/build.done`. A build that is invoked is the invoker's alone.
   */
  locked?: boolean;
  /** The ID of the app whose build function takes a request. */
  app?: string;
  /**
   * The key of the singleton that skips a request while a build of the same
   * thing runs. A request names its lock, and an invoke its own step, which no
   * other invoke shares.
   */
  slot: string;
  /**
   * Set for a job the pipeline called itself, which nothing starts from: the
   * run takes no snapshot, and `cacheKey` only keeps such runs apart.
   */
  direct?: boolean;
  /**
   * What the job starts from, as the invoking run found it. The job's name was
   * worked out from this snapshot, so the build starts from it rather than
   * looking its parent up again.
   */
  base?: CacheBuildResult;
  /** The pipeline's repository, with the working tree's location for local runs. */
  repo?: RepoContext;
  /** The commits the invoking run resolved for other repositories, by source key. */
  sources?: Record<string, ResolvedSource>;
  /** The invoking run's machine settings, for jobs that set none of their own. */
  machine?: MachineConfig;
  /**
   * The ID of the pipeline run at the root of this build: the run itself for a
   * build a pipeline invokes, and the `rootRunId` the invoking build was given
   * for one a build invokes. A job without a `cache` is named under it, so
   * every build in one pipeline shares such a job's snapshot.
   */
  rootRunId: string;
  /** The run that needs the snapshot, and the job there that waits on it. */
  parent: {
    /** The pipeline run that the build's jobs and commands are shown under. */
    runId: string;
    pipelineId: string;
    /** The waiting job's path in that run. */
    jobPath: string;
    /** The event that started that run. */
    trigger: string;
    /** The waiting job's check, which the build tells it is building. */
    check?: { name: string; checkRunId?: number };
  };
}

/** What the build gives back. */
export interface CacheBuildResult {
  /** The job's snapshot, if it had a machine and snapshots could be taken. */
  snapshotId?: string;
  /** Set when that snapshot is cached under the job's name. */
  cached?: CachedSnapshot;
  /** Whether the snapshot was already there, rather than built by this run. */
  reused: boolean;
  /** The key and name the build was asked for, for asking again. */
  target: CacheTarget;
  /** The job and the jobs above it, nearest first, with their resolved key parts. */
  ancestry: Ancestor[];
  /**
   * Snapshots the build left for the pipeline to delete when it ends: those of
   * the builds it invoked in turn, which other builds in the pipeline share.
   */
  createdSnapshots: string[];
  /** The job's line in the pipeline summary, for the run that invoked it. */
  summary?: JobSummary;
  /** The data the job returned, which the invoking run's call resolves to. */
  output?: Record<string, unknown>;
  /** What the invoking run should say about the build, like a fallback. */
  warnings: string[];
  /** How often the job used each public API, for the invoking run's metadata. */
  apis?: CiRunScope["apis"];
  /** How long the reused snapshots it started from took to build, by job ID. */
  cacheSaved?: Record<string, number>;
  /** What the job reported while it ran, for the invoking job's check. */
  report?: { summaries: string[]; annotations: CheckAnnotation[] };
}

/** A matrix as the build runs it: exactly one combination. */
interface MatrixRunner {
  [runCombosKey](combos: Record<string, unknown>[]): Promise<void>;
}

/** The ID of the one function that builds every job's snapshot. */
export const cacheBuildFunctionId = "ci/build";

/**
 * The function that builds any job or matrix combination, as the invoke's
 * data names it. The build run's trace shows the job's own spans, named by
 * its ID.
 */
export const cacheBuildFunction = ({
  client,
  internals,
  jobs,
  matrices,
}: {
  client: Inngest.Any;
  internals: CiInternals;
  jobs: Map<string, RegisteredJob>;
  matrices: Map<string, MatrixJob<MatrixAxes>>;
}): InngestFunction.Any => {
  const id = cacheBuildFunctionId;

  return client.createFunction(
    {
      id,
      name: "build",
      // Every app in the environment would hear a request, so it names the app
      // whose build function is meant to take it.
      triggers: [
        {
          event: buildRequestedEvent,
          if: `event.data.app == "${client.id}"`,
        },
      ],
      // While a build of a lock runs, requests for it are skipped before they
      // start a run or touch a machine. The lock's machine name keeps two
      // builds apart where this cannot: other apps, and the edges of a run.
      singleton: { key: "event.data.slot", mode: "skip" },
      // A run that ends or is cancelled takes with it the jobs it called, which
      // have no one left to report to. A cache build outlives its invoker.
      cancelOn: [
        {
          event: internalEvents.FunctionCancelled,
          if: "async.data.run_id == event.data.rootRunId",
        },
        {
          event: internalEvents.FunctionFinished,
          if: "event.data.direct == true && async.data.run_id == event.data.rootRunId",
        },
      ],
      ...pipelineFunctionOptions,
      middleware: [sandboxMiddleware(), metadataMiddleware()],
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
    async (ctx: any) => {
      const data = ctx.event.data as CacheBuildData;

      return runPipeline({
        internals,
        config: {
          id,
          on: { event: invokedEvent },
          check: false,
          ...(data.machine ? { machine: data.machine } : {}),
        },
        build: data,
        handler: async (): Promise<CacheBuildResult> => {
          return buildSnapshot({ data, jobs, matrices });
        },
        ctx,
      });
    },
  );
};

/** Run the job, or the matrix combination, the build was asked for. */
const runBuilt = async ({
  data,
  jobs,
  matrices,
}: {
  data: CacheBuildData;
  jobs: Map<string, RegisteredJob>;
  matrices: Map<string, MatrixJob<MatrixAxes>>;
}): Promise<void> => {
  if (data.matrix) {
    const matrix = matrices.get(data.matrix.id);

    if (!matrix) {
      throw new NonRetriableError(
        `No matrix with the ID "${data.matrix.id}" is defined, so "${data.jobId}" can't be built. The worker's code may be out of date.`,
      );
    }

    await (matrix as unknown as MatrixRunner)[runCombosKey]([
      data.matrix.combo,
    ]);
  } else {
    const job = jobs.get(data.jobId);

    if (!job) {
      throw new NonRetriableError(
        `No job with the ID "${data.jobId}" is defined, so it can't be built. The worker's code may be out of date.`,
      );
    }

    await runJob({
      config: job.config,
      handler: job.handler,
      input: data.input,
    });
  }
};

/**
 * The name of the cause that carries a failed command across the invoke. An
 * error that crosses a run keeps its name, message and cause, and nothing
 * else, so the fields a check is written from travel in a message.
 */
const failureCause = "CiCommandFailure";

/**
 * A failed command as the error the build run fails with, so the run that
 * invoked it can write the job's check from it as it would have inline.
 * Anything else fails the build as it is.
 */
const encodeFailure = (
  error: unknown,
  report: CacheBuildResult["report"],
): Error | undefined => {
  const failure =
    error instanceof AggregateError && error.errors.length === 1
      ? error.errors[0]
      : error;

  if (
    !(failure instanceof CommandFailedError) &&
    !(failure instanceof CommandTimeoutError)
  ) {
    return undefined;
  }

  const { message, name, stack: _stack, ...fields } = failure;
  const cause = new Error(JSON.stringify({ name, ...fields, report }));

  cause.name = failureCause;

  return new NonRetriableError(message, { cause });
};

/**
 * The failed command a build run failed with, as the error it was inline, or
 * nothing if the build failed some other way.
 */
export const decodeFailure = (error: unknown): Error | undefined => {
  for (
    let cause = (error as { cause?: unknown } | undefined)?.cause;
    cause instanceof Error;
    cause = cause.cause
  ) {
    if (cause.name !== failureCause) {
      continue;
    }

    const { name, report, ...fields } = JSON.parse(cause.message);
    const failure =
      name === "CommandTimeoutError"
        ? new CommandTimeoutError(fields)
        : new CommandFailedError(fields);

    if (report) {
      failedReports.set(failure, report);
    }

    return failure;
  }

  return undefined;
};

/** What a failed build run reported, by the error it decoded to. */
const failedReports = new WeakMap<
  Error,
  NonNullable<CacheBuildResult["report"]>
>();

/** What the build run reported before it failed with `error`, if it did. */
export const failedReport = (error: unknown) => {
  return error instanceof Error ? failedReports.get(error) : undefined;
};

/**
 * Run the job as it would run in a pipeline: it looks its snapshot up, reuses
 * it if another build just took one, and otherwise runs and snapshots.
 */
const buildSnapshot = async ({
  data,
  jobs,
  matrices,
}: {
  data: CacheBuildData;
  jobs: Map<string, RegisteredJob>;
  matrices: Map<string, MatrixJob<MatrixAxes>>;
}): Promise<CacheBuildResult> => {
  const run = getRunScope();

  if (data.askedByApp && run) {
    return answerAppJob({ run, data, jobs });
  }

  try {
    await runBuilt({ data, jobs, matrices });
  } catch (error) {
    throw encodeFailure(error, run?.report) ?? error;
  }

  const request = run?.request ?? requestOf(data);

  // The job's line is the build run's own too, whose totals count it.
  if (run && request.sink.summary) {
    run.summaries.push(request.sink.summary);
  }

  return builtResult(request, data.jobId, {
    createdSnapshots: [...(run?.createdSnapshots ?? [])],
    warnings: run?.warnings ?? [],
    ...(run ? { apis: run.apis } : {}),
    ...(run?.cacheSaved.size
      ? { cacheSaved: Object.fromEntries(run.cacheSaved) }
      : {}),
    ...(run?.report ? { report: run.report } : {}),
  });
};
