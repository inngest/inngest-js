/**
 * What the pipeline check says in each state: how far along it is, what the
 * cache saved, what failed, and the charts. Time saved comes first on a pass,
 * because that is what the reader came to see.
 *
 * @module
 */

import { formatDuration } from "../../util.ts";
import { callout } from "./callout.ts";
import { colorBar } from "./commands.ts";
import { mermaidGraph } from "./dag.ts";
import { chartRows, gantt } from "./gantt.ts";
import { criticalPath, type GraphJob } from "./graph.ts";
import { link, linksRow } from "./links.ts";
import { jobTree } from "./tree.ts";
import {
  type CheckLinks,
  type CheckPayload,
  cancelAction,
  cell,
  rerunAllAction,
  rerunFailedAction,
  rerunFreshAction,
} from "./types.ts";

/** A job that failed, as one row of the failures table. */
export interface FailedJob {
  name: string;
  /** Why it failed, in a few words. */
  why: string;
  /** Whether the reason is probably infrastructure, not the change. */
  infra?: boolean;
  /** The job's check. */
  checkUrl?: string;
  /** The failing step's trace. */
  stepUrl?: string;
  annotations?: number;
}

/** A job that is running, as one row of the running table. */
export interface RunningJob {
  name: string;
  checkUrl?: string;
  command?: string;
  ms?: number;
}

export interface PipelineInput extends CheckLinks {
  state: "running" | "passed" | "failed" | "cancelled";
  /** How long the run has taken, or took. */
  elapsedMs: number;
  /** Every job the run knows of. */
  jobs: GraphJob[];
  /** Cached builds and what each saved. */
  saved?: Array<{ name: string; savedMs: number }>;
  /** How many builds the run needed, cached or not. */
  buildCount?: number;
  /** How much faster the critical path is for the cache. */
  criticalSavedMs?: number;
  failures?: FailedJob[];
  running?: RunningJob[];
  /** Who cancelled, and when, as it should read. */
  cancelledBy?: string;
  cancelledAt?: string;
  /** Notes the run collected, such as a job with nothing to snapshot. */
  notes?: string[];
  /** Whether to draw the Mermaid graph. */
  mermaid?: boolean;
}

interface Counts {
  total: number;
  passed: number;
  failed: number;
  running: number;
  queued: number;
  stopped: number;
}

const countJobs = (jobs: GraphJob[]): Counts => {
  const count = (...states: GraphJob["state"][]) => {
    return jobs.filter((job) => {
      return states.includes(job.state);
    }).length;
  };

  return {
    total: jobs.length,
    passed: count("ok", "cached"),
    failed: count("failed"),
    running: count("running"),
    queued: count("queued"),
    stopped: count("stopped"),
  };
};

const sections = (...parts: Array<string | undefined>): string => {
  return parts
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
};

const plural = (count: number, word: string): string => {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
};

const legend = "░ cache hit   █ done   ◆ critical path";

const chart = (input: PipelineInput, critical: string[]): string => {
  const rows = chartRows(input.jobs, critical);

  const lines = [
    gantt(rows, {
      totalMs: Math.max(input.elapsedMs, 1),
      nowMs: input.elapsedMs,
      critical,
    }),
    legend,
  ];

  if (input.jobs.length > rows.length) {
    lines.push(`… and ${plural(input.jobs.length - rows.length, "more job")}`);
  }

  return ["```text", ...lines, "```"].join("\n");
};

const mermaidBlock = (input: PipelineInput, critical: string[]): string => {
  const rows = chartRows(input.jobs, critical);

  return [
    "```mermaid",
    mermaidGraph(rows, { critical, nowMs: input.elapsedMs }),
    "```",
  ].join("\n");
};

const treeBlock = (jobs: GraphJob[]): string => {
  return [
    "<details>",
    `<summary>🌳 Job tree (${plural(jobs.length, "job")})</summary>`,
    "",
    "```text",
    jobTree(jobs),
    "```",
    "",
    "</details>",
  ].join("\n");
};

const timeline = (input: PipelineInput, critical: string[]): string => {
  return sections(
    "### Timeline",
    chart(input, critical),
    input.mermaid === false ? undefined : mermaidBlock(input, critical),
    input.state === "passed" ? treeBlock(input.jobs) : undefined,
  );
};

const savedTable = (input: PipelineInput): string | undefined => {
  if (!input.saved || input.saved.length === 0) {
    return undefined;
  }

  return [
    "| ⚡ Cached build | Saved |",
    "| --- | --- |",
    ...input.saved.map((entry) => {
      return `| \`${entry.name}\` | **${formatDuration(entry.savedMs)}** |`;
    }),
  ].join("\n");
};

const totalSaved = (input: PipelineInput): number => {
  return (input.saved ?? []).reduce((sum, entry) => {
    return sum + entry.savedMs;
  }, 0);
};

const pathLine = (
  input: PipelineInput,
  critical: string[],
): string | undefined => {
  if (critical.length < 2) {
    return undefined;
  }

  const byId = new Map(
    input.jobs.map((job) => {
      return [job.id, job] as const;
    }),
  );

  const names = critical.map((id) => {
    return `\`${byId.get(id)?.name ?? id}\``;
  });

  const last = byId.get(critical.at(-1) ?? "");

  return `🧭 **Critical path:** ${names.join(", ")}, ${formatDuration(last?.endMs ?? input.elapsedMs)}. Making any other job faster will not make CI faster.`;
};

const slowestTable = (
  input: PipelineInput,
  critical: string[],
): string | undefined => {
  const slowest = input.jobs
    .filter((job) => {
      return job.state === "ok" && job.endMs !== undefined;
    })
    .sort((a, b) => {
      return (b.endMs ?? 0) - b.startMs - ((a.endMs ?? 0) - a.startMs);
    })
    .slice(0, 4);

  const longest = slowest[0];

  if (!longest) {
    return undefined;
  }

  const length = (job: GraphJob): number => {
    return (job.endMs ?? 0) - job.startMs;
  };

  return [
    "| 🐢 Slowest | Time | |",
    "| --- | --- | --- |",
    ...slowest.map((job, index) => {
      return `| ${critical.includes(job.id) ? "🧭 " : ""}${cell(job.name)} | ${formatDuration(length(job))} | ${colorBar(length(job) / length(longest), index === 0 ? "🟨" : "🟩", 10)} |`;
    }),
  ].join("\n");
};

const failuresTable = (failures: FailedJob[]): string => {
  const shown = failures.slice(0, 20);

  const rows = shown.map((job) => {
    const why = `${cell(job.why)}${job.infra ? " (probably infra)" : ""}${job.annotations ? ` · ${plural(job.annotations, "annotation")}` : ""}`;

    return `| ${job.infra ? "⚠️" : "❌"} ${cell(job.name)} | ${why} | ${job.checkUrl ? link("open", job.checkUrl) : ""} | ${job.stepUrl ? link("open", job.stepUrl) : ""} |`;
  });

  return [
    "| Failed job | Why | Check | Step |",
    "| --- | --- | --- | --- |",
    ...rows,
    ...(failures.length > shown.length
      ? [`| … and ${failures.length - shown.length} more | | | |`]
      : []),
  ].join("\n");
};

const runningTable = (running: RunningJob[]): string | undefined => {
  if (running.length === 0) {
    return undefined;
  }

  return [
    "| Running now | Command | Time |",
    "| --- | --- | --- |",
    ...running.slice(0, 10).map((job) => {
      return `| ${job.checkUrl ? link(cell(job.name), job.checkUrl) : cell(job.name)} | ${job.command ? `\`${job.command.replaceAll("`", "'")}\`` : ""} | ${job.ms === undefined ? "" : formatDuration(job.ms)} |`;
    }),
  ].join("\n");
};

const notesCallout = (notes: string[] | undefined): string | undefined => {
  return notes && notes.length > 0
    ? callout(
        "note",
        notes
          .map((note) => {
            return `🧩 ${note}`;
          })
          .join("\n"),
      )
    : undefined;
};

const closingRow = (
  input: PipelineInput,
  lead: string,
  first?: string,
): string => {
  return linksRow(lead, [
    first,
    link("Trace", input.run),
    input.commit
      ? link(`Commit \`${input.commit.sha}\``, input.commit.url)
      : undefined,
    input.pullRequest
      ? link(`PR #${input.pullRequest.number}`, input.pullRequest.url)
      : undefined,
  ]);
};

/** What the pipeline's check shows in its state. */
export const pipelineCheck = (input: PipelineInput): CheckPayload => {
  const counts = countJobs(input.jobs);
  const critical = criticalPath(input.jobs);
  const time = formatDuration(input.elapsedMs);
  const saved = totalSaved(input);
  const savedBuilds = input.saved?.length ?? 0;

  switch (input.state) {
    case "running": {
      const done = counts.passed + counts.failed;
      const fraction = counts.total === 0 ? 0 : done / counts.total;

      const bar = `${"█".repeat(Math.round(fraction * 28))}${"░".repeat(28 - Math.round(fraction * 28))}`;

      const building = input.jobs.filter((job) => {
        return job.state === "running" && job.building;
      }).length;

      return {
        title: `🔄 Running: ${done} of ${counts.total} jobs done, ${counts.failed} failed`,
        summary: sections(
          callout(
            "note",
            `🔄 **${time} in.** ✅ ${counts.passed} passed · 🔄 ${counts.running} running · ⬜ ${counts.queued} queued · ❌ ${counts.failed} failed`,
          ),
          `\`${bar}\` **${Math.round(fraction * 100)}%**`,
          saved > 0
            ? callout(
                "tip",
                `⚡ **${formatDuration(saved)} saved so far** by the cache. ${plural(savedBuilds, "build")} restored${building > 0 ? `, ${building} building` : ""}.`,
              )
            : undefined,
          closingRow(input, "🔗", link("Run and cancel", input.run)),
          "**Timeline** (live)",
          chart(input, []),
          runningTable(input.running ?? []),
        ),
        actions: [cancelAction],
      };
    }

    case "passed": {
      const builds = input.buildCount ?? savedBuilds;

      return {
        title: `✅ Passed: ${plural(counts.total, "job")} in ${time}${saved > 0 ? ` · ⚡ ${formatDuration(saved)} saved by cache` : ""}`,
        summary: sections(
          saved > 0
            ? callout(
                "tip",
                `⚡ **${formatDuration(saved)} of build time skipped by caching.** ${savedBuilds} of ${builds} builds restored.${input.criticalSavedMs ? `\nOn the critical path that is **${formatDuration(input.criticalSavedMs)}** faster.` : ""}`,
              )
            : callout(
                "note",
                `✅ **${plural(counts.total, "job")} passed** in **${time}**.`,
              ),
          saved > 0
            ? `✅ **${plural(counts.total, "job")} passed** in **${time}**`
            : undefined,
          closingRow(input, "🔗"),
          savedTable(input),
          pathLine(input, critical),
          slowestTable(input, critical),
          notesCallout(input.notes),
        ),
        text: timeline(input, critical),
        actions: [],
      };
    }

    case "failed": {
      const failures = input.failures ?? [];
      const anyInfra = failures.some((failure) => {
        return failure.infra;
      });

      return {
        title: `❌ ${counts.failed} of ${counts.total} jobs failed: ${failures
          .slice(0, 2)
          .map((failure) => {
            return failure.name;
          })
          .join(
            ", ",
          )}${failures.length > 2 ? ` and ${failures.length - 2} more` : ""}`,
        summary: sections(
          callout(
            "caution",
            `❌ **${plural(counts.failed, "job")} failed**, ✅ ${counts.passed} passed, in ${time}.${counts.stopped === 0 && counts.queued === 0 ? " Every job ran to the end." : ""}`,
          ),
          closingRow(
            input,
            "👉",
            `Press **Re-run failed jobs**${anyInfra ? " if these look like flakes" : ""}`,
          ),
          failuresTable(failures),
          saved > 0
            ? callout(
                "tip",
                `⚡ **${formatDuration(saved)} saved by caching** · ${savedBuilds} of ${input.buildCount ?? savedBuilds} builds restored.`,
              )
            : undefined,
          pathLine(input, critical),
          notesCallout(input.notes),
        ),
        text: timeline({ ...input, state: "failed" }, critical),
        actions: [rerunFailedAction, rerunFreshAction],
      };
    }

    case "cancelled": {
      const by = input.cancelledBy ? ` by **${input.cancelledBy}**` : "";
      const at = input.cancelledAt ? ` at ${input.cancelledAt}` : "";

      return {
        title: `🛑 Cancelled${input.cancelledBy ? ` by ${input.cancelledBy}` : ""} after ${time}: ${counts.passed} passed, ${counts.total - counts.passed} not finished`,
        summary: sections(
          callout(
            "note",
            `🛑 **Cancelled**${at}${by}. ${counts.failed === 0 ? "Nothing had failed." : `${plural(counts.failed, "job")} had failed.`}`,
          ),
          `✅ ${counts.passed} passed · 🛑 ${counts.stopped} stopped mid-run · ⬜ ${counts.queued} never started`,
          saved > 0
            ? callout(
                "tip",
                `⚡ Passed builds are cached, so a re-run starts from them. **${formatDuration(saved)}** already saved.`,
              )
            : undefined,
          closingRow(input, "👉", "Press **Re-run all jobs**"),
          chart(input, []),
        ),
        actions: [rerunAllAction],
      };
    }
  }
};
