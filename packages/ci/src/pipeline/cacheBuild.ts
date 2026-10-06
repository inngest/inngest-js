/**
 * Building a cached job's snapshot in a run of its own: what a pipeline hands
 * the build, the generated function that does it, and what it hands back.
 *
 * A pipeline with a cached job invokes this function instead of running the
 * job inline. The function is limited to one run per snapshot name, and looks
 * the snapshot up again when it starts, so a burst of runs that all missed the
 * same name builds it once and every one of them gets the same snapshot.
 *
 * @module
 */

import type { Inngest, InngestFunction } from "inngest";
import { metadataMiddleware, sandboxMiddleware } from "inngest/experimental";
import type { CachedSnapshot } from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import type { Matrix, MatrixAxes, RepoContext } from "../types.ts";
import type { RegisteredJob } from "./job.ts";
import { runJob } from "./job.ts";
import { runCombosKey } from "./matrix.ts";
import { runPipeline } from "./pipeline.ts";
import type { CiInternals } from "./scope.ts";
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
  /** The job's resolved cache key, as the pipeline computed it. */
  ownKey: string;
  /**
   * The name the snapshot is written under: scope, job and `ownKey`. Builds
   * are limited to one at a time per name.
   */
  cacheKey: string;
  /**
   * A snapshot that turned out to be bad, which may still hold the name. The
   * build never reuses it.
   */
  exclude?: string;
  /** The pipeline's repository, with the working tree's location for local runs. */
  repo?: RepoContext;
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
  /** What the invoking run should say about the build, like a fallback. */
  warnings: string[];
}

/** A matrix as the build runs it: exactly one combination. */
interface MatrixRunner {
  [runCombosKey](combos: Record<string, unknown>[]): Promise<unknown[]>;
}

/**
 * The build function for a job, or for a matrix, as its ID is shown in the
 * Dev Server: `build <target>`.
 */
export const cacheBuildFunction = ({
  client,
  internals,
  jobs,
  matrices,
  target,
}: {
  client: Inngest.Any;
  internals: CiInternals;
  jobs: Map<string, RegisteredJob>;
  matrices: Map<string, Matrix<MatrixAxes, unknown>>;
  /** The job's ID, or the matrix's. */
  target: string;
}): InngestFunction.Any => {
  const id = `ci/cache-build/${target}`;

  return client.createFunction(
    {
      id,
      name: `build ${target}`,
      // One build per name at a time. Whoever comes next finds it taken.
      concurrency: [{ key: "event.data.cacheKey", limit: 1 }],
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
  matrices: Map<string, Matrix<MatrixAxes, unknown>>;
}): Promise<CacheBuildResult> => {
  if (data.matrix) {
    const matrix = matrices.get(data.matrix.id);

    if (!matrix) {
      throw new CiUsageError(
        `No matrix with the ID "${data.matrix.id}" is defined, so "${data.jobId}" can't be built.`,
      );
    }

    await (matrix as unknown as MatrixRunner)[runCombosKey]([
      data.matrix.combo,
    ]);
  } else {
    const job = jobs.get(data.jobId);

    if (!job) {
      throw new CiUsageError(
        `No job with the ID "${data.jobId}" is defined, so it can't be built.`,
      );
    }

    await runJob({
      config: job.config,
      handler: job.handler,
      input: data.input,
    });
  }

  const run = getRunScope();
  const cached = run?.cached.get(data.jobId);
  const snapshotId = await run?.snapshots.get(data.jobId);

  return {
    ...(snapshotId ? { snapshotId } : {}),
    ...(cached
      ? {
          cached: {
            snapshotId: cached.snapshotId,
            name: cached.name,
            createdAt: cached.createdAt,
          },
        }
      : {}),
    reused: cached?.restored ?? false,
    warnings: run?.warnings ?? [],
  };
};
