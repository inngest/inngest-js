/**
 * The job graph as Mermaid, which GitHub draws in check output: cache hits in
 * yellow, failures in red, the critical path as thick edges.
 *
 * @module
 */

import { formatDuration } from "../../util.ts";
import type { GraphJob } from "./graph.ts";

const classes = {
  ok: "ok",
  cached: "hit",
  failed: "bad",
  running: "run",
  stopped: "stop",
  queued: "wait",
} as const;

const icons = {
  ok: "✅",
  cached: "⚡",
  failed: "❌",
  running: "🔄",
  stopped: "🛑",
  queued: "⏳",
} as const;

/** Text safe inside a quoted Mermaid label. */
const safe = (text: string): string => {
  return text.replaceAll('"', "'").replaceAll("<", "‹").replaceAll(">", "›");
};

const detail = (job: GraphJob, nowMs: number): string => {
  switch (job.state) {
    case "cached":
      return `saved ${formatDuration(job.savedMs ?? 0)}`;
    case "queued":
      return "queued";
    default:
      return formatDuration((job.endMs ?? nowMs) - job.startMs);
  }
};

/** A Mermaid `flowchart` of `jobs`, ready to put in a `mermaid` fence. */
export const mermaidGraph = (
  jobs: GraphJob[],
  options: { critical?: string[]; nowMs?: number } = {},
): string => {
  // Job IDs are paths with spaces and punctuation, which Mermaid can't take.
  const ids = new Map(
    jobs.map((job, index) => {
      return [job.id, `j${index}`] as const;
    }),
  );

  const lines = ["flowchart LR"];

  for (const job of jobs) {
    const label = `${icons[job.state]} ${safe(job.name)}<br/>${detail(job, options.nowMs ?? 0)}`;

    lines.push(`  ${ids.get(job.id)}["${label}"]:::${classes[job.state]}`);
  }

  for (const job of jobs) {
    for (const parent of job.parents) {
      const from = ids.get(parent);

      if (!from) {
        continue;
      }

      const onPath =
        options.critical?.includes(parent) && options.critical.includes(job.id);

      lines.push(`  ${from} ${onPath ? "==>" : "-->"} ${ids.get(job.id)}`);
    }
  }

  lines.push(
    "  classDef ok fill:#143d26,stroke:#56d364,color:#e6e7e9",
    "  classDef hit fill:#3d3412,stroke:#e3b341,color:#e6e7e9",
    "  classDef bad fill:#40191b,stroke:#ff7b72,color:#e6e7e9",
    "  classDef run fill:#10294a,stroke:#58a6ff,color:#e6e7e9",
    "  classDef stop fill:#3d3412,stroke:#8b949e,color:#e6e7e9",
    "  classDef wait fill:#22262d,stroke:#8b949e,color:#e6e7e9",
  );

  return lines.join("\n");
};
