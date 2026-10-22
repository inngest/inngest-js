/**
 * What a job's check says in each state, from the data the job has. The
 * callout answers the reader's main question, one row holds every link, and a
 * command shows only once it has started.
 *
 * @module
 */

import type { ErrorClass } from "../../errors.ts";
import { fenceFor, formatDuration } from "../../util.ts";
import { type CalloutKind, callout } from "./callout.ts";
import { type CommandRow, commandsTable } from "./commands.ts";
import { link, linksRow } from "./links.ts";
import {
  type CheckLinks,
  type CheckPayload,
  cancelAction,
  rerunFreshAction,
} from "./types.ts";

export type { ErrorClass };

/** A line of an excerpt, marked when it is the error itself. */
export interface ExcerptLine {
  text: string;
  bad?: boolean;
}

/** Counts of what one tool reported. */
export interface ToolCount {
  tool: string;
  errors: number;
  warnings: number;
  notices: number;
}

/** A failed job, as the check tells it. */
export interface JobFailure {
  errorClass: ErrorClass;
  /** The reason, for the title. */
  title: string;
  /** The failing command's step, which is where to look in the trace. */
  stepId?: string;
  /** The callout's text, in markdown, without a leading symbol. */
  headline: string;
  /** Files and lines to open first. */
  open?: Array<{ label: string; url: string }>;
  /** The lines that matter, drawn as a diff so the errors are red. */
  excerpt?: ExcerptLine[];
  /** Sentences below the excerpt. */
  notes?: string[];
  tools?: ToolCount[];
  /** The failing command's output, for the collapsed block. */
  log?: string;
}

/** What every state knows about the job. */
export interface JobContext extends CheckLinks {
  /** The job's name, for titles. */
  name: string;
  /** The `from` parent's check. */
  parent?: { name: string; url?: string };
  /** The machine, as in `4 vCPU, 8 GiB`. */
  machine?: string;
  /** Commands that have started or finished. */
  commands?: CommandRow[];
  /** How long the job has run or did run. */
  elapsedMs?: number;
  /** How long starting from the parent's cache saved. */
  savedMs?: number;
}

export type JobState =
  | {
      kind: "queued";
      waitingFor?: { name: string; url?: string; elapsedMs?: number };
    }
  | {
      kind: "waiting-build";
      /** The build being waited for. */
      build: string;
      builder: {
        url: string;
        pullRequest?: { number: number; url: string };
        commit?: { sha: string; url: string };
        elapsedMs: number;
        usualMs?: number;
      };
      lock?: string;
      missReason?: string;
    }
  | {
      kind: "building";
      reason?: string;
      /** How many jobs here wait on the build, when known. */
      waiting?: number;
      otherRuns?: Array<{ label: string; url: string }>;
      restoreMs?: number;
      usualMs?: number;
    }
  | { kind: "running"; current?: string }
  | {
      kind: "cache-hit";
      restoredMs: number;
      builtMs?: number;
      builtAgo?: string;
      entry?: string;
      snapshot?: string;
      builtBy?: { label: string; url: string };
      usedBy?: number;
    }
  | {
      kind: "passed";
      parentAge?: string;
      tests?: { passed: number; files?: number };
      coverage?: string;
      notice?: { label: string; url: string };
    }
  | { kind: "failed"; failure: JobFailure }
  | {
      kind: "cancelled";
      by?: string;
      during?: string;
      /** Why, when it was not a person: such as the pipeline ending first. */
      reason?: string;
    }
  | {
      kind: "skipped";
      paths?: string[];
      changed?: string[];
      reason?: string;
    };

export type JobInput = JobContext & { state: JobState };

const plural = (count: number, word: string): string => {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
};

const commitLink = (context: CheckLinks): string | undefined => {
  return context.commit
    ? link(`Commit \`${context.commit.sha}\``, context.commit.url)
    : undefined;
};

const prLink = (context: CheckLinks): string | undefined => {
  return context.pullRequest
    ? link(`PR #${context.pullRequest.number}`, context.pullRequest.url)
    : undefined;
};

const parentLink = (context: JobContext): string | undefined => {
  return context.parent?.url
    ? link(`Parent \`${context.parent.name}\``, context.parent.url)
    : undefined;
};

const savedText = (context: JobContext): string | undefined => {
  return context.savedMs
    ? `⚡ ${formatDuration(context.savedMs)} saved by cache`
    : undefined;
};

/** Parts joined as one line, skipping the missing ones. */
const facts = (...parts: Array<string | undefined>): string => {
  return parts.filter(Boolean).join(" · ");
};

/** Sections joined by blank lines, skipping the empty ones. */
const sections = (...parts: Array<string | undefined>): string => {
  return parts
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
};

const machineText = (context: JobContext): string | undefined => {
  return context.machine ? `🖥️ ${context.machine}` : undefined;
};

const excerptBlock = (lines: ExcerptLine[]): string => {
  const body = lines.map((line) => {
    return `${line.bad ? "- " : "  "}${line.text}`;
  });

  const fence = fenceFor(body.join("\n"));

  return `${fence}diff\n${body.join("\n")}\n${fence}`;
};

const logBlock = (log: string): string => {
  const fence = fenceFor(log);

  return [
    "<details>",
    "<summary>📜 Full log of the failing command (colours removed)</summary>",
    "",
    `${fence}text`,
    log,
    fence,
    "",
    "</details>",
  ].join("\n");
};

const failedCallout = (failure: JobFailure): string => {
  const kinds: Record<
    JobFailure["errorClass"],
    { kind: CalloutKind; icon: string }
  > = {
    sandbox: { kind: "warning", icon: "⚠️" },
    infra: { kind: "warning", icon: "⚠️" },
    oom: { kind: "warning", icon: "⚠️" },
    timeout: { kind: "caution", icon: "⏱️" },
    signal: { kind: "caution", icon: "🛑" },
    test: { kind: "caution", icon: "❌" },
    code: { kind: "caution", icon: "❌" },
    failure: { kind: "caution", icon: "❌" },
  };

  const { kind, icon } = kinds[failure.errorClass];

  return callout(kind, `${icon} ${failure.headline}`);
};

const toolsTable = (tools: ToolCount[]): string => {
  return [
    "| Tool | ❌ Errors | ⚠️ Warnings | 💬 Notices |",
    "| --- | --- | --- | --- |",
    ...tools.map((tool) => {
      return `| \`${tool.tool}\` | ${tool.errors} | ${tool.warnings} | ${tool.notices} |`;
    }),
  ].join("\n");
};

const failed = (input: JobInput, failure: JobFailure): CheckPayload => {
  const rerunFirst =
    failure.errorClass === "infra" ||
    failure.errorClass === "sandbox" ||
    failure.errorClass === "oom" ||
    failure.errorClass === "timeout";

  const row = linksRow("👉", [
    ...(rerunFirst
      ? ["Re-run the pipeline"]
      : (failure.open ?? []).map((target, index) => {
          return index === 0
            ? `**Open** ${link(target.label, target.url)}`
            : link(target.label, target.url);
        })),
    input.step ? link("Failing step", input.step) : undefined,
    // There is no link to a step in the trace, so the run's link says which.
    link(
      failure.stepId && !input.step
        ? `Trace, failing step \`${failure.stepId}\``
        : "Trace",
      input.run,
    ),
    parentLink(input),
    commitLink(input),
    prLink(input),
  ]);

  const summary = sections(
    failedCallout(failure),
    row,
    failure.excerpt?.length ? excerptBlock(failure.excerpt) : undefined,
    failure.notes?.join("\n\n"),
    failure.tools?.length ? toolsTable(failure.tools) : undefined,
    facts(
      input.elapsedMs === undefined
        ? undefined
        : `⏱️ ${formatDuration(input.elapsedMs)}`,
      savedText(input),
      machineText(input),
    ),
    commandsTable(input.commands ?? []),
  );

  const prefix = failure.errorClass === "timeout" ? "⏱️" : "❌";

  return {
    title: `${prefix} ${failure.title}`,
    summary,
    ...(failure.log ? { text: logBlock(failure.log) } : {}),
    actions: [rerunFreshAction],
  };
};

/** What a job's check shows in its state. */
export const jobCheck = (input: JobInput): CheckPayload => {
  const state = input.state;
  const row = (lead: string, extra: Array<string | undefined> = []) => {
    return linksRow(lead, [...extra, commitLink(input), prLink(input)]);
  };

  switch (state.kind) {
    case "queued": {
      const waiting = state.waitingFor;
      const what = waiting
        ? `Starts when ${waiting.url ? link(`\`${waiting.name}\``, waiting.url) : `\`${waiting.name}\``} finishes.${waiting.elapsedMs === undefined ? "" : ` It has been running for ${formatDuration(waiting.elapsedMs)}.`}`
        : "Waiting for a machine.";

      return {
        title: waiting
          ? `⏳ Queued: waiting for \`${waiting.name}\``
          : "⏳ Queued",
        summary: sections(
          callout("note", `⏳ **Queued.** ${what}`),
          row("🔗", [link("Run and cancel", input.run)]),
          input.machine ? `🖥️ Will run on **${input.machine}**` : undefined,
        ),
        actions: [cancelAction],
      };
    }

    case "waiting-build": {
      const { builder } = state;
      const left =
        builder.usualMs === undefined
          ? undefined
          : Math.max(0, builder.usualMs - builder.elapsedMs);

      const progress = `${formatDuration(builder.elapsedMs)} in${builder.usualMs === undefined ? "" : `, usually ${formatDuration(builder.usualMs)}`}`;

      return {
        title: `⏳ Waiting on another run's build of \`${state.build}\`${left === undefined ? "" : ` (about ${formatDuration(left)} left)`}`,
        summary: sections(
          callout(
            "important",
            `⏳ **Not stuck.** Another run is building the snapshot this job needs: ${progress}.${left === undefined ? "" : ` About **${formatDuration(left)} left**.`}`,
          ),
          linksRow("🔗", [
            link("This run (cancel here)", input.run),
            link("The builder", builder.url),
            builder.pullRequest
              ? link(
                  `PR #${builder.pullRequest.number}`,
                  builder.pullRequest.url,
                )
              : undefined,
            builder.commit
              ? link(`Commit \`${builder.commit.sha}\``, builder.commit.url)
              : undefined,
          ]),
          facts(
            state.lock ? `🔒 Lock \`${state.lock}\`` : undefined,
            state.missReason ? `🧩 Cache miss: ${state.missReason}` : undefined,
          ),
          callout(
            "tip",
            "💡 Nothing is built twice. This job starts the moment the snapshot exists.",
          ),
        ),
        actions: [cancelAction],
      };
    }

    case "building": {
      const others = (state.otherRuns ?? []).map((other) => {
        return link(other.label, other.url);
      });

      const waiting = state.waiting ?? 0;

      const waiters =
        others.length > 0
          ? `**${plural(waiting, "job")}** here and ${others.length} other run${others.length === 1 ? "" : "s"} (${others.join(", ")}) are waiting on it.`
          : `**${plural(waiting, "job")}** here ${waiting === 1 ? "is" : "are"} waiting on it.`;

      return {
        title: `🧱 Building cache for \`${input.name}\`${input.elapsedMs === undefined ? "" : ` (${formatDuration(input.elapsedMs)})`}`,
        summary: sections(
          callout(
            "note",
            `🧱 **Building a new cache entry.** ${state.reason ? `${state.reason} ` : ""}${waiting > 0 || others.length > 0 ? waiters : ""}`.trim(),
          ),
          row("🔗", [link("Watch the build", input.run)]),
          commandsTable(input.commands ?? []),
          state.restoreMs === undefined
            ? undefined
            : callout(
                "tip",
                `⚡ Once built, the next runs restore it in about **${formatDuration(state.restoreMs)}**${state.usualMs === undefined ? "" : ` instead of ${formatDuration(state.usualMs)}`}.`,
              ),
        ),
        actions: [cancelAction],
      };
    }

    case "running": {
      const current = (input.commands ?? []).find((command) => {
        return command.state === "running";
      });

      const name = state.current ?? current?.command;

      const saved = savedText(input);

      return {
        title: `🔄 Running${name ? ` \`${name}\`` : ""}${current?.ms === undefined ? "" : ` (${formatDuration(current.ms)})`}`,
        summary: sections(
          saved
            ? callout(
                "tip",
                `⚡ **${formatDuration(input.savedMs ?? 0)} saved** by starting from the cached ${input.parent?.url ? link(`\`${input.parent.name}\``, input.parent.url) : `\`${input.parent?.name ?? "build"}\``}.`,
              )
            : callout(
                "note",
                `🔄 **Running**${input.elapsedMs === undefined ? "" : ` for ${formatDuration(input.elapsedMs)}`}.`,
              ),
          row("🔗", [
            link("Watch live", input.step ?? input.run),
            link("Cancel run", input.run),
          ]),
          facts(
            "🔄 **Running**",
            input.elapsedMs === undefined
              ? undefined
              : `⏱️ ${formatDuration(input.elapsedMs)}`,
            machineText(input),
          ),
          commandsTable(input.commands ?? []),
        ),
        actions: [cancelAction],
      };
    }

    case "cache-hit": {
      const rows = [
        ...(state.entry
          ? [
              `| 💾 Entry | \`${state.entry}\`${state.builtAgo ? `, built ${state.builtAgo}` : ""} |`,
            ]
          : []),
        ...(state.snapshot ? [`| 📦 Snapshot | \`${state.snapshot}\` |`] : []),
        ...(state.usedBy === undefined
          ? []
          : [
              `| 🔁 Used by | ${state.usedBy} job${state.usedBy === 1 ? "" : "s"} in this run |`,
            ]),
      ];

      const instead =
        state.builtMs === undefined
          ? ""
          : ` instead of building for ${formatDuration(state.builtMs)}`;

      return {
        title: input.savedMs
          ? `⚡ Cache hit: ${formatDuration(input.savedMs)} saved`
          : `⚡ Cache hit${state.builtAgo ? `, built ${state.builtAgo}` : ""}`,
        summary: sections(
          callout(
            "tip",
            input.savedMs
              ? `⚡ **Cache hit. ${formatDuration(input.savedMs)} saved.**\nRestored in **${formatDuration(state.restoredMs)}**${instead}.`
              : "⚡ **Cache hit.** Restored from the cache instead of building.",
          ),
          row("🔗", [
            link("Run", input.run),
            state.builtBy
              ? link(state.builtBy.label, state.builtBy.url)
              : undefined,
          ]),
          rows.length > 0
            ? ["| | |", "| --- | --- |", ...rows].join("\n")
            : undefined,
        ),
        actions: [],
      };
    }

    case "passed": {
      const time =
        input.elapsedMs === undefined
          ? ""
          : ` in ${formatDuration(input.elapsedMs)}`;
      const saved = input.savedMs
        ? ` · ⚡ ${formatDuration(input.savedMs)} saved by cache`
        : "";

      const parent = input.parent?.url
        ? link(`\`${input.parent.name}\``, input.parent.url)
        : input.parent
          ? `\`${input.parent.name}\``
          : "the cached build";

      return {
        title: `✅ Passed${time}${saved}`,
        summary: sections(
          facts(
            `✅ **Passed**${input.elapsedMs === undefined ? "" : ` in **${formatDuration(input.elapsedMs)}**`}`,
            machineText(input),
          ),
          input.savedMs
            ? callout(
                "tip",
                `⚡ **${formatDuration(input.savedMs)} saved** by starting from the cached ${parent}${state.parentAge ? ` (${state.parentAge} old)` : ""}.`,
              )
            : undefined,
          row("🔗", [
            link("Trace", input.run),
            state.notice
              ? link(state.notice.label, state.notice.url)
              : undefined,
          ]),
          facts(
            state.tests
              ? `🧪 **${state.tests.passed} tests passed**${state.tests.files === undefined ? "" : ` in ${state.tests.files} files`}`
              : undefined,
            state.coverage ? `📊 coverage **${state.coverage}**` : undefined,
          ),
          commandsTable(input.commands ?? []),
        ),
        actions: [],
      };
    }

    case "failed":
      return failed(input, state.failure);

    case "cancelled": {
      const by = state.by ? ` by ${state.by}` : "";
      const after =
        input.elapsedMs === undefined
          ? ""
          : ` after ${formatDuration(input.elapsedMs)}`;

      return {
        title: `🛑 Cancelled${by}${after}`,
        summary: sections(
          callout(
            "note",
            `🛑 **Cancelled**${state.by ? ` by **${state.by}**` : ""}${state.during ? ` while \`${state.during}\` was running` : ""}${state.reason ? `: ${state.reason}` : ""}.`,
          ),
          row("🔗", [link("Trace", input.run)]),
          commandsTable(input.commands ?? []),
        ),
        actions: [],
      };
    }

    case "skipped": {
      const rules = (state.paths ?? []).map((path) => {
        return `- \`${path}\``;
      });

      const changed = state.changed ?? [];

      return {
        title: `⏭️ Skipped${state.reason ? `: ${state.reason}` : ""}`,
        summary: sections(
          callout(
            "note",
            [
              `⏭️ **Skipped.** No machine started.${rules.length > 0 ? " This job only runs when these paths change:" : ""}`,
              ...rules,
            ].join("\n"),
          ),
          changed.length > 0
            ? `This change touches ${changed.length} file${changed.length === 1 ? "" : "s"}, none matching: ${changed
                .slice(0, 1)
                .map((path) => {
                  return `\`${path}\``;
                })
                .join(
                  "",
                )}${changed.length > 1 ? ` and ${changed.length - 1} more` : ""}.`
            : undefined,
          row("🔗", [link("Run", input.run)]),
        ),
        actions: [],
      };
    }
  }
};
