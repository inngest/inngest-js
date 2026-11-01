/**
 * The text Gantt chart: one bar per job against the run's clock, in a code
 * fence so it renders everywhere.
 *
 * @module
 */

import { formatDuration } from "../../util.ts";
import type { GraphJob, GraphJobState } from "./graph.ts";

const bars: Record<GraphJobState, string> = {
  ok: "█",
  cached: "░",
  failed: "█",
  running: "▓",
  stopped: "▒",
  queued: " ",
};

const fit = (text: string, width: number): string => {
  return text.length >= width ? text.slice(0, width) : text.padEnd(width);
};

const labelOf = (job: GraphJob, nowMs: number): string => {
  const ended = job.endMs ?? nowMs;

  switch (job.state) {
    case "queued":
      return "queued";
    case "cached":
      return `cache hit, saved ${formatDuration(job.savedMs ?? 0)} ⚡`;
    case "running":
      return `${formatDuration(nowMs - job.startMs)}${job.building ? " building" : ""} 🔄`;
    case "stopped":
      return `stopped at ${formatDuration(nowMs - job.startMs)} 🛑`;
    case "failed":
      return `${formatDuration(ended - job.startMs)} ❌`;
    default:
      return `${formatDuration(ended - job.startMs)} ✅`;
  }
};

/**
 * The chart for `jobs`, `width` columns wide, covering `totalMs` of the run.
 * `nowMs` is where unfinished jobs end. Jobs on `critical` are marked.
 */
export const gantt = (
  jobs: GraphJob[],
  options: {
    totalMs: number;
    nowMs: number;
    critical?: string[];
    width?: number;
  },
): string => {
  const width = options.width ?? 40;
  const nameWidth = 30;
  const total = Math.max(1, options.totalMs);

  const lines = jobs.map((job) => {
    const ended = job.endMs ?? options.nowMs;
    const from = Math.round((job.startMs / total) * width);
    const to = Math.max(from + 1, Math.round((ended / total) * width));

    const bar =
      job.state === "queued"
        ? `${" ".repeat(Math.min(width - 3, Math.round((options.nowMs / total) * width)))}···`
        : `${" ".repeat(from)}${bars[job.state].repeat(to - from)}`;

    const mark =
      options.critical?.includes(job.id) && job.state !== "queued" ? "  ◆" : "";

    return `${fit(job.name, nameWidth)}│${fit(bar, width)}│ ${labelOf(job, options.nowMs)}${mark}`;
  });

  const end = formatDuration(options.totalMs);
  const axis = `${" ".repeat(nameWidth)} 0s${" ".repeat(Math.max(1, width - 2 - end.length))}${end}`;

  return [...lines, axis].join("\n");
};

/**
 * The jobs worth drawing when a run has too many for a chart: failures, jobs
 * in flight, cache hits and the critical path first, then the slowest, in the
 * order they started.
 */
export const chartRows = (
  jobs: GraphJob[],
  critical: string[],
  max = 16,
): GraphJob[] => {
  const rank = (job: GraphJob): number => {
    if (job.state === "failed") {
      return 0;
    }

    if (job.state === "running" || job.state === "stopped") {
      return 1;
    }

    if (critical.includes(job.id)) {
      return 2;
    }

    return job.state === "cached" ? 3 : 4;
  };

  const length = (job: GraphJob): number => {
    return (job.endMs ?? job.startMs) - job.startMs;
  };

  return [...jobs]
    .sort((a, b) => {
      return rank(a) - rank(b) || length(b) - length(a);
    })
    .slice(0, max)
    .sort((a, b) => {
      return a.startMs - b.startMs;
    });
};
