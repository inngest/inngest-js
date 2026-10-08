/**
 * Building a job's snapshot in a run of its own: what a pipeline hands the
 * build, the one generated function that does it, and what it hands back.
 *
 * A pipeline invokes this function for a cached job, and for any job another
 * job starts `from`, instead of running the job inline. One function builds
 * every job: the invoke's data says which. It is limited to one run per
 * snapshot name, which is unique across jobs, and looks the snapshot up again
 * when it starts, so a burst of runs that all missed the same name builds it
 * once and every one of them gets the same snapshot.
 *
 * @module
 */

import type { Inngest, InngestFunction } from "inngest";
import { NonRetriableError } from "inngest";
import { metadataMiddleware, sandboxMiddleware } from "inngest/experimental";
import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import { cycleMessage } from "../machine/from.ts";
import type { Matrix, MatrixAxes, RepoContext } from "../types.ts";
import type { AppJobRequest } from "./appJob.ts";
import { answerAppJob } from "./appJob.ts";
import type { RegisteredJob } from "./job.ts";
import { runJob } from "./job.ts";
import { runCombosKey } from "./matrix.ts";
import { pipelineFunctionOptions, runPipeline } from "./pipeline.ts";
import type { CiInternals, JobSummary } from "./scope.ts";
import { getRunScope } from "./scope.ts";

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
  /** The job's input, for jobs that take one. */
  input?: unknown;
  /**
   * The job's resolved cache key, as the pipeline computed it. For a job
   * without a `cache`, its input's hash, if it has one.
   */
  ownKey: string;
  /**
   * The name the snapshot is written under: scope, job and `ownKey`, where the
   * scope of a job without a `cache` is the pipeline run. Builds are limited
   * to one at a time per name.
   */
  cacheKey: string;
  /**
   * The jobs whose builds led to this one, outermost first: each build run
   * adds its own job when it invokes another. A build asked for a job that's
   * already here is a cycle of `from`s.
   */
  chain?: string[];
  /**
   * A snapshot that turned out to be bad, which may still hold the name. The
   * build never reuses it.
   */
  exclude?: string;
  /**
   * What the job starts from, as the invoking run found it. The job's name was
   * worked out from this snapshot, so the build starts from it rather than
   * looking its parent up again.
   */
  base?: CacheBuildResult;
  /**
   * The snapshot of the base image the job starts from, as the invoking run
   * resolved it. The job's name has this snapshot's ID, so the build starts
   * from it rather than looking the image up again.
   */
  image?: CachedSnapshot;
  /**
   * Set when another app asks for one of this app's jobs with `image.job()`.
   * The asking app can't name the job's snapshot, so this run resolves it.
   */
  resolve?: AppJobRequest;
  /** The pipeline's repository, with the working tree's location for local runs. */
  repo?: RepoContext;
  /**
   * The ID of the pipeline run at the root of this build: the run itself for a
   * build a pipeline invokes, and the `rootRunId` the invoking build was given
   * for one a build invokes. A job without a `cache` is named under it, so
   * every build in one pipeline shares one build per such job.
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
  /** Whether the job ran commands, so there was a machine to snapshot. */
  hadMachine: boolean;
  /**
   * Snapshots the build left for the pipeline to delete when it ends: those of
   * the builds it invoked in turn, which other builds in the pipeline share.
   */
  createdSnapshots: string[];
  /** The job's line in the pipeline summary, for the run that invoked it. */
  summary?: JobSummary;
  /** What the invoking run should say about the build, like a fallback. */
  warnings: string[];
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
  matrices: Map<string, Matrix<MatrixAxes>>;
}): InngestFunction.Any => {
  const id = cacheBuildFunctionId;

  return client.createFunction(
    {
      id,
      name: "build",
      // One build per name at a time. Whoever comes next finds it taken.
      concurrency: [{ key: "event.data.cacheKey", limit: 1 }],
      ...pipelineFunctionOptions,
      middleware: [sandboxMiddleware(), metadataMiddleware()],
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
    async (ctx: any) => {
      const data = ctx.event.data as CacheBuildData;

      return runPipeline({
        internals,
        config: { id, on: { event: invokedEvent }, check: false },
        build: data,
        handler: async (): Promise<CacheBuildResult> => {
          return buildSnapshot({ data, jobs, matrices });
        },
        ctx,
      });
    },
  );
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
  matrices: Map<string, Matrix<MatrixAxes>>;
}): Promise<CacheBuildResult> => {
  if (data.chain?.includes(data.jobId)) {
    throw new NonRetriableError(cycleMessage([...data.chain, data.jobId]));
  }

  const asking = getRunScope();

  if (data.resolve && asking) {
    return answerAppJob({
      run: asking,
      request: data.resolve,
      input: data.input,
      jobs,
    });
  }

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

  const run = getRunScope();
  const outcome = run?.outcome;

  const summary = run?.summaries.find((candidate) => {
    return candidate.path === data.jobId;
  });

  return {
    ...(outcome?.snapshotId ? { snapshotId: outcome.snapshotId } : {}),
    ...(outcome?.cached ? { cached: outcome.cached } : {}),
    reused: outcome?.reused ?? false,
    target: { ownKey: data.ownKey, name: data.cacheKey },
    hadMachine: outcome?.hadMachine ?? false,
    createdSnapshots: [...(run?.createdSnapshots ?? [])],
    ...(summary ? { summary } : {}),
    warnings: run?.warnings ?? [],
  };
};
