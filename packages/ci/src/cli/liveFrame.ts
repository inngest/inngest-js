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

const detailOf = (job: JobState): string => {
  if (isOpen(job.status)) {
    return job.doing ?? job.status;
  }

  // A passed job's title only repeats its time, and a failed job's title
  // its failing command, which is drawn under it.
  return job.status === "passed" || job.failure ? "" : (job.title ?? "");
};

/** A matrix's node: its status is the most urgent of its cells'. */
const groupOf = (label: string, cells: Node[]): Node => {
  const open = cells.some((cell) => {
    return isOpen(cell.status);
  });
  const urgent = (["failed", "running", "queued", "cancelled"] as const).find(
    (status) => {
      return cells.some((cell) => {
        return cell.status === status;
      });
    },
  );

  return {
    label,
    status: urgent ?? cells[0]?.status ?? "queued",
    detail: "",
    startedAt: Math.min(
      ...cells.map((cell) => {
        return cell.startedAt;
      }),
    ),
    endedAt: open
      ? undefined
      : Math.max(
          ...cells.map((cell) => {
            return cell.endedAt ?? 0;
          }),
        ),
    children: cells,
  };
};

/** The nodes of the jobs started from `parentId`, with matrix cells grouped. */
const nodesOf = (jobs: JobState[], parentId?: string): Node[] => {
  const known = new Set(
    jobs.map((job) => {
      return job.id;
    }),
  );
  const siblings = jobs.filter((job) => {
    if (parentId === undefined) {
      return !job.parentId || !known.has(job.parentId);
    }

    return job.parentId === parentId;
  });
  const nodeOf = (job: JobState, label: string): Node => {
    return {
      label,
      status: job.status,
      detail: detailOf(job),
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      failure: job.failure,
      children: nodesOf(jobs, job.id),
    };
  };
  // A matrix takes the place of its first cell.
  const slots: (Node | string)[] = [];
  const groups = new Map<string, Node[]>();

  for (const job of siblings) {
    const [, name, cell] = cellOf.exec(job.id) ?? [];

    if (!name || !cell) {
      slots.push(nodeOf(job, job.id));

      continue;
    }

    if (!groups.has(name)) {
      groups.set(name, []);
      slots.push(name);
    }

    groups.get(name)?.push(nodeOf(job, cell));
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

  if (flat.length <= width) {
    return flat;
  }

  return `${flat.slice(0, Math.max(0, width - 1))}…`;
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
  body: { text: string; style: Style }[];
}

const rowsOf = (nodes: Node[], indent: string, width: number): Row[] => {
  return nodes.flatMap((node, index) => {
    const last = index === nodes.length - 1;
    const below = indent + (last ? "   " : "│  ");
    const room = width - below.length - 4;
    const { failure } = node;
    const body: Row["body"] = failure
      ? [
          {
            text: fit(
              `$ ${failure.command} exited with ${failure.exitCode ?? "?"}`,
              room,
            ),
            style: "red",
          },
          ...failure.tail
            .split("\n")
            .map((line) => {
              return fit(line, room);
            })
            .filter(Boolean)
            .slice(-tailLines)
            .map((text): Row["body"][number] => {
              return { text, style: "dim" };
            }),
        ]
      : [];

    return [
      { tree: `${indent}${last ? "└─" : "├─"}`, below, node, body },
      ...rowsOf(node.children, below, width),
    ];
  });
};

const outcomes = {
  passed: ["✓", "green"],
  failed: ["✕", "red"],
  cancelled: ["⊘", "yellow"],
} as const;

/** The lines of one frame. */
export const frame = (state: LiveState, options: FrameOptions): string[] => {
  const { now, width, tick, color } = options;
  const clock = state.endedAt ?? now;
  const spin = spinnerFrames[tick % spinnerFrames.length] as string;
  const paint = (style: Style, text: string): string => {
    return color ? styleText(style, text, { validateStream: false }) : text;
  };
  const name = state.name ?? "inngest-ci";
  const title = [
    state.conclusion ? "" : `${paint("yellow", spin)} `,
    paint("bold", name),
    state.url ? paint("dim", `  ${state.url}`) : "",
  ].join("");

  if (state.jobs.length === 0) {
    return [title, `  ${paint("dim", state.status)}`];
  }

  const rows = rowsOf(nodesOf(state.jobs), "", width);
  const labelWidth = Math.max(
    ...rows.map((row) => {
      return row.tree.length + 3 + row.node.label.length;
    }),
  );
  const times = rows.map(({ node }) => {
    if (node.status === "queued") {
      return "";
    }

    return formatDuration((node.endedAt ?? clock) - node.startedAt);
  });
  const timeWidth = Math.max(
    ...times.map((time) => {
      return time.length;
    }),
  );
  const room = Math.min(
    width - labelWidth - timeWidth - 4,
    Math.max(
      ...rows.map((row) => {
        return row.node.detail.length;
      }),
    ),
  );
  const lines = rows.flatMap(({ tree, below, node, body }, index) => {
    const [mark, style] = icons[node.status];
    const left = `${tree} ${mark || spin} ${node.label}`;
    const line = [
      paint("dim", tree),
      " ",
      paint(style, mark || spin),
      " ",
      node.label,
      " ".repeat(labelWidth - left.length + 2),
      paint("dim", fit(node.detail, room).padEnd(room)),
      "  ",
      paint("dim", (times[index] ?? "").padStart(timeWidth)),
    ].join("");

    return [
      line.trimEnd(),
      ...body.map((entry) => {
        return `${paint("dim", below)} ${paint(entry.style, entry.text)}`;
      }),
    ];
  });
  const { conclusion } = state;
  const [mark, tone] = outcomes[conclusion?.status ?? "passed"];
  const summary = conclusion
    ? [
        "",
        `${paint(tone, mark)} ${name} ${conclusion.status} in ${formatDuration(clock - state.startedAt)}`,
        ...(conclusion.reason
          ? [paint("dim", `  ${fit(conclusion.reason, width - 2)}`)]
          : []),
      ]
    : [];

  return [
    title,
    ...lines,
    ...state.warnings.map((text) => {
      return paint("yellow", `! ${fit(text, width - 2)}`);
    }),
    ...summary,
  ];
};
