/**
 * What the pipeline check's charts draw: the jobs of a run with their parents
 * and times, and the critical path through them.
 *
 * @module
 */

export type GraphJobState =
  | "ok"
  | "cached"
  | "failed"
  | "running"
  | "stopped"
  | "queued";

export interface GraphJob {
  /** Unique within the run. */
  id: string;
  /** What the job is called on the check. */
  name: string;
  /** IDs of the jobs this one starts from. */
  parents: string[];
  state: GraphJobState;
  /** Milliseconds from the start of the run to when the job started. */
  startMs: number;
  /** Milliseconds from the start of the run to when it ended, once it has. */
  endMs?: number;
  /** For a cache hit, how long the build it skipped took. */
  savedMs?: number;
  /** Whether a running job is building a cache entry. */
  building?: boolean;
}

/**
 * The IDs of the jobs on the critical path, first to last: from the job that
 * finished last back through whichever parent finished last. Only these make
 * the run faster when they get faster.
 */
export const criticalPath = (jobs: GraphJob[]): string[] => {
  const byId = new Map(
    jobs.map((job) => {
      return [job.id, job] as const;
    }),
  );

  const ended = jobs
    .filter((job) => {
      return job.endMs !== undefined && job.state !== "queued";
    })
    .sort((a, b) => {
      return (b.endMs ?? 0) - (a.endMs ?? 0);
    });

  let current = ended[0];
  const path: string[] = [];

  while (current && !path.includes(current.id)) {
    path.unshift(current.id);

    current = current.parents
      .map((id) => {
        return byId.get(id);
      })
      .filter((job): job is GraphJob => {
        return job?.endMs !== undefined;
      })
      .sort((a, b) => {
        return (b.endMs ?? 0) - (a.endMs ?? 0);
      })[0];
  }

  return path;
};
