/**
 * What the pipeline's check shows, worked out from what the run's jobs have
 * recorded about themselves: when each started and ended, what it started from,
 * what it saved, and why it failed.
 *
 * @module
 */

import type { GraphJob, GraphJobState } from "../github/render/graph.ts";
import type { PipelineInput } from "../github/render/pipeline.ts";
import { pipelineCheck } from "../github/render/pipeline.ts";
import type { CheckPayload } from "../github/render/types.ts";
import { runLinks } from "./jobReport.ts";
import type { CiRunScope, JobNode } from "./scope.ts";

/** Record something about a job in the run, for the pipeline's check. */
export const markJob = (
  run: CiRunScope,
  path: string,
  patch: Partial<Omit<JobNode, "path">>,
): void => {
  const node = run.jobGraph.get(path) ?? {
    path,
    parents: [],
    state: "queued" as const,
  };

  run.jobGraph.set(path, { ...node, ...patch, path });
};

const stateOf = (node: JobNode): GraphJobState => {
  return node.state;
};

/**
 * The jobs for the charts. Builds that were reused have no job of their own in
 * this run, so each one the cache saved appears as a job that took no time, at
 * the start, which is how it felt.
 */
export const graphJobs = (run: CiRunScope, now: number): GraphJob[] => {
  const origin = run.startedAt ?? now;
  const nodes = [...run.jobGraph.values()];
  const known = new Set(nodes.map((node) => node.path));

  const firstStart = Math.min(
    ...nodes.map((node) => {
      return node.startedAt ?? now;
    }),
    now,
  );

  const reused: GraphJob[] = [...run.cacheSaved]
    .filter(([id]) => {
      return !known.has(id);
    })
    .map(([id, savedMs]) => {
      return {
        id,
        name: id,
        parents: [],
        state: "cached" as const,
        startMs: 0,
        endMs: Math.max(0, firstStart - origin),
        savedMs,
      };
    });

  const direct: GraphJob[] = nodes.map((node) => {
    const saved = run.cacheSaved.get(node.path);

    return {
      id: node.path,
      name: node.path,
      parents: node.parents,
      state: stateOf(node),
      startMs: Math.max(0, (node.startedAt ?? now) - origin),
      ...(node.endedAt === undefined
        ? {}
        : { endMs: Math.max(0, node.endedAt - origin) }),
      ...(node.state === "cached" && saved !== undefined
        ? { savedMs: saved }
        : {}),
      ...(node.building ? { building: true } : {}),
    };
  });

  return [...reused, ...direct];
};

/**
 * The pipeline's check as the run stands. Read it inside the step that sends
 * it, so the clock is the step's.
 */
export const pipelinePayload = (
  run: CiRunScope,
  state: PipelineInput["state"],
  extra: {
    error?: PipelineInput["error"];
    notes?: string[];
  } = {},
): CheckPayload => {
  const now = Date.now();
  const nodes = [...run.jobGraph.values()];
  const repo = run.repo;

  const checkUrl = (node: JobNode): string | undefined => {
    return node.checkRunId !== undefined && repo
      ? `https://github.com/${repo.fullName}/runs/${node.checkRunId}`
      : undefined;
  };

  const failures = nodes
    .filter((node) => {
      return node.state === "failed";
    })
    .map((node) => {
      const url = checkUrl(node);

      return {
        name: node.path,
        why: node.failure?.why ?? "failed",
        ...(node.failure?.infra ? { infra: true } : {}),
        ...(url ? { checkUrl: url } : {}),
        ...(node.failure?.stepUrl ? { stepUrl: node.failure.stepUrl } : {}),
        ...(node.annotations ? { annotations: node.annotations } : {}),
      };
    });

  const running = nodes
    .filter((node) => {
      return node.state === "running";
    })
    .map((node) => {
      const url = checkUrl(node);

      return {
        name: node.path,
        ...(url ? { checkUrl: url } : {}),
        ...(node.startedAt === undefined ? {} : { ms: now - node.startedAt }),
      };
    });

  const saved = [...run.cacheSaved].map(([name, savedMs]) => {
    return { name, savedMs };
  });

  const built = nodes.filter((node) => {
    return node.building || node.built;
  }).length;

  return pipelineCheck({
    ...runLinks(run),
    state,
    elapsedMs: run.startedAt === undefined ? 0 : now - run.startedAt,
    jobs: graphJobs(run, now),
    saved,
    buildCount: saved.length + built,
    failures,
    running,
    notes: [...(extra.notes ?? [])],
    ...(extra.error ? { error: extra.error } : {}),
  });
};
