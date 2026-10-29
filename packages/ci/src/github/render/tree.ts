/**
 * The job tree: each job under the job it starts from, with its result.
 *
 * @module
 */

import { formatDuration } from "../../util.ts";
import type { GraphJob } from "./graph.ts";

const labelOf = (job: GraphJob): string => {
  const ms = (job.endMs ?? job.startMs) - job.startMs;

  switch (job.state) {
    case "cached":
      return `⚡ cache hit, saved ${formatDuration(job.savedMs ?? 0)}`;
    case "failed":
      return `❌ ${formatDuration(ms)}`;
    case "running":
      return "🔄 running";
    case "stopped":
      return "🛑 stopped";
    case "queued":
      return "⏳ queued";
    default:
      return `✅ ${formatDuration(ms)}`;
  }
};

/** The tree as text for a code fence. Jobs with no known parent are roots. */
export const jobTree = (jobs: GraphJob[]): string => {
  const known = new Set(
    jobs.map((job) => {
      return job.id;
    }),
  );
  const lines: string[] = [];

  const walk = (
    job: GraphJob,
    prefix: string,
    last: boolean,
    root: boolean,
    path: string[],
  ) => {
    const text = `${job.name}  ${labelOf(job)}`;

    lines.push(root ? text : `${prefix}${last ? "└─ " : "├─ "}${text}`);

    const kids = jobs.filter((kid) => {
      return kid.parents.includes(job.id) && !path.includes(kid.id);
    });

    for (const [index, kid] of kids.entries()) {
      walk(
        kid,
        root ? "" : `${prefix}${last ? "   " : "│  "}`,
        index === kids.length - 1,
        false,
        [...path, job.id],
      );
    }
  };

  for (const job of jobs) {
    if (!job.parents.some((parent) => known.has(parent))) {
      walk(job, "", true, true, []);
    }
  }

  return lines.join("\n");
};
