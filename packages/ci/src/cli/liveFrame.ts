/**
 * The model and the picture of a live run: `apply` folds the app's messages
 * into a {@link LiveState}, and `frame` draws that state as the lines of a
 * tree of jobs. Pure apart from `apply` mutating the state it is given, so a
 * frame can be checked with fixed inputs.
 *
 * @module
 */

import { styleText } from "node:util";

import type { LocalMessage, LocalStatus } from "../local/protocol.ts";

/** Lines of a failed command's output shown under its job. */
const tailLines = 8;

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface JobState {
  id: string;
  status: LocalStatus;
  parentId?: string;
  title?: string;
  /** The command or activity while the job runs. */
  doing?: string;
  startedAt: number;
  endedAt?: number;
  failure?: { command: string; exitCode?: number; tail: string };
}

export interface LiveState {
  /** What the run is called, once known. */
  name?: string;
  url?: string;
  /** What is happening before any job reports. */
  status: string;
  jobs: JobState[];
  warnings: string[];
  startedAt: number;
  endedAt?: number;
  /** How the run ended, once it has. */
  conclusion?: { status: "passed" | "failed" | "cancelled"; reason?: string };
}

export const isOpen = (status: LocalStatus): boolean => {
  return status === "queued" || status === "running";
};

export const createState = (now: number): LiveState => {
  return { status: "Starting", jobs: [], warnings: [], startedAt: now };
};

/** Fold one message of the run into the state. */
export const apply = (state: LiveState, message: LocalMessage): void => {
  if (message.kind === "warning") {
    if (!state.warnings.includes(message.text)) {
      state.warnings.push(message.text);
    }

    return;
  }

  if (
    message.kind !== "job" &&
    message.kind !== "activity" &&
    message.kind !== "command"
  ) {
    return;
  }

  let job = state.jobs.find((candidate) => {
    return candidate.id === message.jobId;
  });

  if (!job) {
    job = { id: message.jobId, status: "queued", startedAt: message.at };

    state.jobs.push(job);
  }

  if (message.kind === "activity" && isOpen(job.status)) {
    job.doing = message.text;
  }

  if (message.kind === "command") {
    if (message.status === "running") {
      job.doing = `$ ${message.name}`;
    }

    if (message.status === "failed") {
      job.failure = {
        command: message.name,
        exitCode: message.exitCode,
        tail: message.outputTail ?? "",
      };
    }
  }

  if (message.kind === "job") {
    if (job.status === "queued" && message.status !== "queued") {
      job.startedAt = message.at;
    }

    job.status = message.status;
    job.parentId = message.parentId ?? job.parentId;
    job.title = message.title ?? job.title;

    if (!isOpen(message.status)) {
      job.endedAt = message.at;
      job.doing = undefined;
    }
  }
};

/** Whole seconds up to a minute, then minutes and seconds. */
export const formatDuration = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1000));

  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** A job, or the cells of a matrix grouped under its name. */
interface Node {
  label: string;
  status: LocalStatus;
  detail: string;
  startedAt: number;
  endedAt?: number;
  failure?: JobState["failure"];
  children: Node[];
}

const cellOf = /^(.+?) \((.+)\)$/;

/** Statuses a matrix shows ahead of the rest: it reads as its worst cell. */
const urgency: LocalStatus[] = ["failed", "running", "queued", "cancelled"];

const groupOf = (label: string, cells: Node[]): Node => {
  const statuses = cells.map((cell) => {
    return cell.status;
  });
  const ends = cells.map((cell) => {
    return cell.endedAt ?? 0;
  });

  return {
    label,
    status:
      urgency.find((status) => {
        return statuses.includes(status);
      }) ?? "passed",
    detail: "",
    startedAt: Math.min(
      ...cells.map((cell) => {
        return cell.startedAt;
      }),
    ),
    endedAt: statuses.some(isOpen) ? undefined : Math.max(...ends),
    children: cells,
  };
};

/** The nodes of the jobs started from `parentId`, with matrix cells grouped. */
const nodesOf = (jobs: JobState[], parentId?: string): Node[] => {
  const ids = jobs.map((job) => {
    return job.id;
  });
  const nodeOf = (job: JobState, label: string): Node => {
    // A passed job's title only repeats its time, and a failed job's its
    // failing command, which is drawn under it.
    const quiet = job.status === "passed" || job.failure;

    return {
      ...job,
      label,
      detail: isOpen(job.status)
        ? (job.doing ?? job.status)
        : (!quiet && job.title) || "",
      children: nodesOf(jobs, job.id),
    };
  };
  const groups = new Map<string, Node[]>();
  const slots: (Node | string)[] = [];

  for (const job of jobs) {
    const root = !job.parentId || !ids.includes(job.parentId);

    if (parentId === undefined ? !root : job.parentId !== parentId) {
      continue;
    }

    const [, name, cell] = cellOf.exec(job.id) ?? [];

    if (!name || !cell) {
      slots.push(nodeOf(job, job.id));

      continue;
    }

    // A matrix takes the place of its first cell.
    if (!groups.has(name)) {
      slots.push(name);
    }

    groups.set(name, [...(groups.get(name) ?? []), nodeOf(job, cell)]);
  }

  return slots.map((slot) => {
    return typeof slot === "string"
      ? groupOf(slot, groups.get(slot) ?? [])
      : slot;
  });
};

type Style = Parameters<typeof styleText>[0];

const icons: Record<LocalStatus, [string, Style]> = {
  passed: ["✓", "green"],
  cached: ["✓", "green"],
  failed: ["✕", "red"],
  cancelled: ["⊘", "yellow"],
  skipped: ["–", "dim"],
  queued: ["○", "dim"],
  running: ["", "yellow"],
};

/** Cut to one line of at most `width` characters. */
const fit = (text: string, width: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();

  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
};

const widest = (texts: string[]): number => {
  return Math.max(
    ...texts.map((text) => {
      return text.length;
    }),
  );
};

export interface FrameOptions {
  now: number;
  width: number;
  /** Picks the spinner frame; any integer. */
  tick: number;
  color: boolean;
}

/** One printed row of the tree, before its columns are aligned. */
interface Row {
  tree: string;
  /** What the tree continues with under this row. */
  below: string;
  node: Node;
  time: string;
}

const rowsOf = (
  nodes: Node[],
  indent: string,
  took: (node: Node) => string,
): Row[] => {
  return nodes.flatMap((node, index) => {
    const last = index === nodes.length - 1;
    const below = indent + (last ? "   " : "│  ");
    const time = node.status === "queued" ? "" : took(node);

    return [
      { tree: `${indent}${last ? "└─" : "├─"}`, below, node, time },
      ...rowsOf(node.children, below, took),
    ];
  });
};

/** The lines of one frame. */
export const frame = (state: LiveState, options: FrameOptions): string[] => {
  const { now, width, tick, color } = options;
  const { conclusion } = state;
  const clock = state.endedAt ?? now;
  const paint = (style: Style, text: string): string => {
    return color ? styleText(style, text, { validateStream: false }) : text;
  };
  const icon = (status: LocalStatus): string => {
    const [mark, style] = icons[status];

    return paint(style, mark || (spinnerFrames[tick % 10] as string));
  };
  const took = (item: { startedAt: number; endedAt?: number }): string => {
    return formatDuration((item.endedAt ?? clock) - item.startedAt);
  };
  const name = state.name ?? "inngest-ci";
  const title = [
    conclusion ? "" : `${icon("running")} `,
    paint("bold", name),
    paint("dim", state.url ? `  ${state.url}` : ""),
  ].join("");

  if (state.jobs.length === 0) {
    return [title, `  ${paint("dim", state.status)}`];
  }

  const rows = rowsOf(nodesOf(state.jobs), "", took);
  const labelWidth = widest(
    rows.map((row) => {
      return `${row.tree}   ${row.node.label}`;
    }),
  );
  const timeWidth = widest(
    rows.map((row) => {
      return row.time;
    }),
  );
  const detailWidth = Math.min(
    width - labelWidth - timeWidth - 4,
    widest(
      rows.map((row) => {
        return row.node.detail;
      }),
    ),
  );
  const lines = rows.flatMap(({ tree, below, node, time }) => {
    const label = `${tree}   ${node.label}`;
    const room = width - below.length - 4;
    const { failure } = node;
    const output = failure
      ? [
          paint(
            "red",
            fit(
              `$ ${failure.command} exited with ${failure.exitCode ?? "?"}`,
              room,
            ),
          ),
          ...failure.tail
            .split("\n")
            .map((line) => {
              return fit(line, room);
            })
            .filter(Boolean)
            .slice(-tailLines)
            .map((line) => {
              return paint("dim", line);
            }),
        ]
      : [];

    return [
      [
        paint("dim", tree),
        ` ${icon(node.status)} ${node.label}`,
        " ".repeat(labelWidth - label.length + 2),
        paint("dim", fit(node.detail, detailWidth).padEnd(detailWidth)),
        paint("dim", `  ${time.padStart(timeWidth)}`),
      ]
        .join("")
        .trimEnd(),
      ...output.map((line) => {
        return `${paint("dim", below)} ${line}`;
      }),
    ];
  });

  return [
    title,
    ...lines,
    ...state.warnings.map((text) => {
      return paint("yellow", `! ${fit(text, width - 2)}`);
    }),
    ...(conclusion
      ? [
          "",
          `${icon(conclusion.status)} ${name} ${conclusion.status} in ${took(state)}`,
          ...(conclusion.reason
            ? [paint("dim", `  ${fit(conclusion.reason, width - 2)}`)]
            : []),
        ]
      : []),
  ];
};
