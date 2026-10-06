/**
 * Turns the model into the lines of one frame: a header, the setup stages,
 * the runs as a tree of jobs, and a footer. Pure, so a frame can be checked at
 * a fixed width. Lines are cut to the width, never wrapped, because the
 * interactive renderer redraws them in place.
 *
 * @module
 */

import { stripVTControlCharacters } from "node:util";
import type { LocalStatus } from "../../local/protocol.ts";
import {
  compose,
  describeTargets,
  formatElapsed,
  oneLine,
  type Paint,
  statusIcon,
  truncate,
} from "./format.ts";
import {
  type CommandView,
  displayActivity,
  isTerminal,
  type JobView,
  type Model,
  type RunView,
  runsStartedAt,
  type StageName,
} from "./model.ts";

/** Frames are never wider than this, however wide the terminal is. */
export const maxWidth = 80;

/** Lines of a failed command's output to show under its job. */
const tailLines = 8;

const stageLabels: Record<StageName, string> = {
  config: "Config",
  "dev-server": "Dev Server",
  app: "App",
  sync: "Sync",
  send: "Run",
  start: "Waiting",
  cleanup: "Cleanup",
};

export interface FrameOptions {
  /** The terminal's width in columns. */
  width: number;
  /** The current time, for running timers. */
  now: number;
  /** The spinner's current frame. Omit for a final frame, which doesn't animate. */
  spinner?: string;
  /** Which selectable row to highlight, counting runs and jobs in order. */
  selected?: number;
  /** A dim line to end with, such as the keys. */
  hint?: string;
  paint: Paint;
}

/** One line of the tree: a stage, a run or a job. */
interface Row {
  /** The run it belongs to, for rows that can be selected. */
  runId?: string;
  /** The tree lines drawn before the icon. */
  prefix: string;
  status: LocalStatus;
  name: string;
  bold: boolean;
  detail: string;
  elapsedMs?: number;
  /** Lines under the row, such as a failure's output, drawn in `bodyIndent`. */
  body: { text: string; red?: boolean }[];
  bodyIndent: string;
}

/**
 * What each selectable row opens, in the order the rows are drawn: a run's
 * URL, and a job's own run when another run builds it.
 */
export const selectableUrls = (model: Model): string[] => {
  return model.runs.flatMap((run) => {
    return [
      run.url,
      ...run.jobs.map((job) => {
        return job.url ?? run.url;
      }),
    ];
  });
};

const commandText = (command: CommandView): string => {
  // `$` marks a command, so it reads apart from a status like `cached`.
  const name = `$ ${oneLine(command.name)}`;

  return command.attempt > 1 ? `${name} · attempt ${command.attempt}` : name;
};

const jobDetail = (run: RunView, job: JobView): string => {
  if (job.status === "cached") {
    return "cached";
  }

  const command = job.commands.at(-1);

  const activity = displayActivity(run, job);

  if (activity) {
    return oneLine(activity);
  }

  if (command) {
    return commandText(command);
  }

  return oneLine(job.title ?? (job.status === "skipped" ? "skipped" : ""));
};

const failureBody = (job: JobView): Row["body"] => {
  if (job.status !== "failed") {
    return [];
  }

  const failed = job.commands.filter((command) => {
    return command.status === "failed";
  });
  const command = failed.at(-1) ?? job.commands.at(-1);
  const output = (command?.outputTail ?? "")
    .split("\n")
    .map(oneLine)
    .filter(Boolean)
    .slice(-tailLines);

  return [
    ...(job.title ? [{ text: oneLine(job.title), red: true }] : []),
    ...output.map((text) => {
      return { text };
    }),
  ];
};

const elapsed = (
  item: { status: LocalStatus; startedAt: number; endedAt?: number },
  clock: number,
): number | undefined => {
  if (item.status === "queued" || item.status === "skipped") {
    return undefined;
  }

  return (item.endedAt ?? clock) - item.startedAt;
};

/** A job's rows, then its `from()` children's, drawn as a tree. */
const jobRows = (run: RunView, clock: number): Row[] => {
  const ids = new Set(
    run.jobs.map((job) => {
      return job.jobId;
    }),
  );
  const walk = (parentId: string | undefined, indent: string): Row[] => {
    const siblings = run.jobs.filter((job) => {
      if (parentId === undefined) {
        return !job.parentId || !ids.has(job.parentId);
      }

      return job.parentId === parentId;
    });

    return siblings.flatMap((job, index) => {
      const last = index === siblings.length - 1;
      const continuation = indent + (last ? "   " : "│  ");
      const row: Row = {
        runId: run.runId,
        prefix: indent + (last ? "└─ " : "├─ "),
        status: job.status,
        name: oneLine(job.jobId),
        bold: false,
        detail: jobDetail(run, job),
        elapsedMs: elapsed(job, clock),
        body: failureBody(job),
        bodyIndent: `${continuation}  `,
      };

      return [row, ...walk(job.jobId, continuation)];
    });
  };

  return walk(undefined, "");
};

const rowsOf = (model: Model, clock: number): Row[] => {
  const stages = model.stages
    .filter((stage) => {
      return !model.header || stage.status !== "done";
    })
    .map((stage): Row => {
      return {
        prefix: "",
        status: stage.status === "done" ? "passed" : stage.status,
        name: stageLabels[stage.stage],
        bold: false,
        detail: oneLine(stage.detail ?? ""),
        elapsedMs: (stage.endedAt ?? clock) - stage.startedAt,
        body: [],
        bodyIndent: "  ",
      };
    });
  const runs = model.runs.flatMap((run): Row[] => {
    const runRow: Row = {
      runId: run.runId,
      prefix: "",
      status: run.status,
      name: oneLine(run.name),
      bold: true,
      detail: run.status === "failed" ? "" : oneLine(run.reason ?? ""),
      elapsedMs: elapsed(run, clock),
      body:
        run.status === "failed" && run.reason
          ? [{ text: oneLine(run.reason), red: true }]
          : [],
      bodyIndent: "  ",
    };

    return [runRow, ...jobRows(run, clock)];
  });

  return [...stages, ...runs];
};

/** The two lines every frame starts with: what's run, and where. */
export const headerLines = (
  model: Model,
  frameWidth: number,
  paint: Paint,
): string[] => {
  const width = frameWidth - 2;
  const { header, targets } = model;

  if (!header) {
    return [];
  }

  const { devServerUrl } = header;
  const ids = (targets?.targets ?? [])
    .map((target) => {
      return target.id;
    })
    .join(", ");
  const app = model.stages.find((stage) => {
    return stage.stage === "app";
  })?.detail;

  return [
    compose(width, paint, [
      { text: `inngest-ci${ids && ` ${ids}`}`, style: "bold" },
      {
        text: `  ${describeTargets(header.repo, targets?.targets)}`,
        style: "dim",
      },
    ]),
    compose(width, paint, [
      { text: "Dev Server", style: "dim" },
      { text: `  ${devServerUrl}` },
      ...(app ? [{ text: `   app  ${app}`, style: "dim" as const }] : []),
    ]),
  ].map((line) => {
    return `  ${line}`;
  });
};

const formatRow = (
  row: Row,
  layout: { labelWidth: number; timeWidth: number },
  width: number,
  gutter: string,
  paint: Paint,
  spinner: string | undefined,
): string => {
  const time = row.elapsedMs === undefined ? "" : formatElapsed(row.elapsedMs);
  const reserved = layout.timeWidth > 0 ? layout.timeWidth + 2 : 0;
  const fixed = 2 + row.prefix.length + 2;
  const nameBudget = Math.max(1, width - fixed - reserved);
  const name = truncate(row.name, nameBudget);
  const nameCell = Math.min(layout.labelWidth - row.prefix.length, nameBudget);
  const detailBudget = width - fixed - nameCell - 2 - reserved;
  const detail = detailBudget >= 2 ? truncate(row.detail, detailBudget) : "";
  const used = fixed + nameCell + (detail ? 2 + detail.length : 0);
  const gap = " ".repeat(Math.max(2, width - used - layout.timeWidth));

  return [
    gutter,
    paint("dim", row.prefix),
    statusIcon(row.status, spinner, paint),
    " ",
    row.bold ? paint("bold", name) : name,
    " ".repeat(nameCell - name.length),
    detail ? `  ${paint("dim", detail)}` : "",
    time ? `${gap}${paint("dim", time.padStart(layout.timeWidth))}` : "",
  ]
    .join("")
    .trimEnd();
};

const bodyLines = (row: Row, width: number, paint: Paint): string[] => {
  const indent = `  ${row.bodyIndent}`;

  return row.body.map(({ text, red }) => {
    const fitted = truncate(text, Math.max(1, width - indent.length));

    return `${indent}${paint(red ? "red" : "dim", fitted)}`;
  });
};

const setupErrorLines = (
  model: Model,
  width: number,
  paint: Paint,
): string[] => {
  const error = model.setupError;

  if (!error) {
    return [];
  }

  const indent = "    ";
  const fit = (text: string): string => {
    return truncate(oneLine(text), width - indent.length);
  };

  return [
    `  ${compose(width - 2, paint, [
      { text: "✕ ", style: "red" },
      { text: oneLine(error.message) },
    ])}`,
    ...(error.fix ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        return `${indent}${truncate(line.trimEnd(), width - indent.length)}`;
      }),
    ...(error.logTail ?? "")
      .split("\n")
      .map(fit)
      .filter(Boolean)
      .map((line) => {
        return `${indent}${paint("dim", line)}`;
      }),
  ];
};

const summaryLines = (model: Model, width: number, paint: Paint): string[] => {
  const { conclusion } = model;

  if (!conclusion || conclusion === "setup-error") {
    return [];
  }

  const took = formatElapsed((model.endedAt ?? 0) - runsStartedAt(model));
  const outcome = {
    passed: paint("green", "✓ Passed"),
    failed: paint("red", "✕ Failed"),
    cancelled: paint("yellow", "⊘ Cancelled"),
  }[conclusion];

  const [run] = model.runs;
  const failure = model.runs.find((item) => {
    return item.status === "failed" && item.reason;
  });
  const lead = `  ${outcome} ${paint("dim", `in ${took}`)}`;
  const plainLead = stripVTControlCharacters(lead).length;
  const why =
    conclusion === "failed" && failure?.reason
      ? truncate(
          ` — ${model.runs.length > 1 ? `${failure.name}: ` : ""}${oneLine(failure.reason)}`,
          Math.max(0, width - plainLead),
        )
      : "";

  const warnings = model.runs.flatMap((item) => {
    return item.warnings.map((text) => {
      return `  ${paint("yellow", truncate(`! ${oneLine(text)}`, width - 2))}`;
    });
  });

  return [
    `${lead}${paint("dim", why)}`,
    ...warnings,
    ...(run && model.runs.length === 1
      ? [
          `  ${compose(width - 2, paint, [
            { text: "Open later  ", style: "dim" },
            { text: `inngest-ci open ${run.runId}` },
          ])}`,
        ]
      : []),
  ];
};

/** The lines of one frame, each already cut to fit `options.width`. */
export const frame = (model: Model, options: FrameOptions): string[] => {
  const { paint, now, spinner, selected, hint } = options;
  const width = Math.min(options.width, maxWidth);
  const clock = model.endedAt ?? now;
  const rows = rowsOf(model, clock);
  const layout = {
    labelWidth: Math.max(
      0,
      ...rows.map((row) => {
        return row.prefix.length + row.name.length;
      }),
    ),
    timeWidth: Math.max(
      0,
      ...rows.map((row) => {
        return row.elapsedMs === undefined
          ? 0
          : formatElapsed(row.elapsedMs).length;
      }),
    ),
  };
  const highlighted = rows.filter((row) => {
    return row.runId !== undefined;
  })[selected ?? -1];
  const body = rows.flatMap((row) => {
    const gutter = row === highlighted ? paint("bold", "› ") : "  ";

    return [
      formatRow(row, layout, width, gutter, paint, spinner),
      ...bodyLines(row, width, paint),
    ];
  });
  const sections = [
    headerLines(model, width, paint),
    body,
    setupErrorLines(model, width, paint),
    summaryLines(model, width, paint),
    hint ? [`  ${paint("dim", truncate(hint, width - 2))}`] : [],
  ].filter((section) => {
    return section.length > 0;
  });

  return sections.flatMap((section, index) => {
    return index === 0 ? section : ["", ...section];
  });
};
