/**
 * What every step and span CI writes is called in the trace. Rows you wrote
 * read the way you wrote them, and CI's own work reads as a plain-English
 * action. Names are for reading only: step IDs, which replays depend on, are
 * built where each step is and never from a name.
 *
 * CI's own work is also marked with CI's origin, so a trace can set it apart
 * from what you wrote. Rows you wrote are never marked.
 *
 * @module
 */

import type { CheckConclusion } from "../types.ts";
import { formatDuration } from "../util.ts";
import { version } from "../version.ts";
import type { CiRunScope } from "./scope.ts";
import { joinId, scopeSeparator } from "./scope.ts";
import type { SpanInfo, SpanKind } from "./spans.ts";
import { originOption } from "./spans.ts";

/**
 * Marks a step or span as work CI does for you rather than something you
 * wrote, as the SDK's experimental step origin and span `origin`.
 * Steps inherit it from the innermost span that has one, so marking a span
 * marks everything in it.
 */
export const ciOrigin = `@inngest/ci@${version}`;

/** A span for something you wrote or asked for, such as a job or a command. */
const userSpan = (kind: SpanKind, id: string, name: string): SpanInfo => {
  return { kind, id, name };
};

/** A span CI opens for its own work, such as starting a sandbox. */
const ciSpan = (kind: SpanKind, id: string, name: string): SpanInfo => {
  return { ...userSpan(kind, id, name), origin: ciOrigin };
};

/**
 * Every span CI opens: its kind, ID, name and whose work it is, in one place.
 * A new span is an entry here and a `inSpan(spans.x(...), fn)` where it
 * opens. Spans of what you wrote have no origin.
 */
export const spans = {
  /** A job, which holds everything it does. */
  job: (run: CiRunScope, path: string): SpanInfo => {
    return userSpan("job", path, traceName.job(run, path));
  },

  /** The run's one span for reporting to GitHub. */
  github: (): SpanInfo => {
    return ciSpan("github", "github", traceName.github);
  },

  /** A machine starting, with its fallbacks. */
  startMachine: (stepId: string, parent?: string): SpanInfo => {
    return ciSpan("sandbox", stepId, traceName.startMachine(parent));
  },

  /** An extra sandbox, named as `sandbox()` was. */
  extraMachine: (path: string, jobPath: string): SpanInfo => {
    return userSpan("sandbox", path, traceName.extraMachine(path, jobPath));
  },

  /**
   * A command. A statement on a background process, such as its `kill`, is a
   * span of its own beside the command's.
   */
  command: (
    stepId: string,
    text: string,
    label?: string,
    statement?: { suffix: string; label: string },
  ): SpanInfo => {
    const name = traceName.command(text, label);

    return statement
      ? userSpan(
          "command",
          joinId(stepId, statement.suffix),
          `${name} (${statement.label})`,
        )
      : userSpan("command", stepId, name);
  },

  /** One attempt of a command that has retries. */
  attempt: (attempt: number): SpanInfo => {
    return ciSpan("attempt", `attempt-${attempt}`, traceName.attempt(attempt));
  },

  /** Saving a job's sandbox: one statement, whatever steps it takes. */
  save: (jobPath: string): SpanInfo => {
    return ciSpan("snapshot", joinId(jobPath, "save"), traceName.saveMachine);
  },
};

/**
 * A step CI runs for you where no span of CI's marks it, such as a command's
 * `Start process` inside the command's span, which is yours.
 */
export const ciStep = (id: string, name: string) => {
  return { id, name, ...originOption(ciOrigin) };
};

/** How a finished check reads, as in `Report test: passed`. */
const outcomes: Partial<Record<CheckConclusion, string>> = {
  success: "passed",
  failure: "failed",
  timed_out: "timed out",
};

export const traceName = {
  /** A job's span: its `name`, or its path when it has none. */
  job: (run: CiRunScope, path: string): string => {
    return run.ci.jobs.get(path)?.config.name ?? path;
  },

  /** The span a job's sandbox starts in. */
  startMachine: (parent?: string): string => {
    return parent ? `Start sandbox from ${parent}` : "Start sandbox";
  },

  /** The span of an extra sandbox, named as `sandbox()` was. */
  extraMachine: (path: string, jobPath: string): string => {
    return path.slice(jobPath.length + scopeSeparator.length);
  },

  /** A command's span: its `.as()` label, or the command itself. */
  command: (text: string, label?: string): string => {
    return label ?? `$ ${text}`;
  },

  attempt: (attempt: number): string => {
    return `Attempt ${attempt}`;
  },

  wait: (ms: number): string => {
    return `Wait ${formatDuration(ms)}`;
  },

  exited: (exitCode: number): string => {
    return `Exited with code ${exitCode}`;
  },

  buildInOwnRun: (path: string): string => {
    return `Build ${path} in its own run`;
  },

  createCheck: (check: string): string => {
    return `Create check: ${check}`;
  },

  completeCheck: (check: string): string => {
    return `Complete check: ${check}`;
  },

  /** A check update, as in `Report test: started`. */
  report: (subject: string, status: string): string => {
    return `Report ${subject}: ${status}`;
  },

  retrying: (attempt: number, of: number): string => {
    return `retrying (attempt ${attempt} of ${of})`;
  },

  outcome: (conclusion: CheckConclusion): string => {
    return outcomes[conclusion] ?? conclusion;
  },

  /** A `github.*` helper you called, by its method name. */
  githubHelper: (helper: string): string => {
    return `github.${helper}`;
  },

  canUser: (login: string, permission: string): string => {
    return `Check ${login} can ${permission}`;
  },

  waitForCheck: (name: string): string => {
    return `Wait for check: ${name}`;
  },

  waitForWorkflow: (workflow: string): string => {
    return `Wait for workflow: ${workflow}`;
  },

  github: "GitHub",
  resolveRepository: "Resolve repository",
  commentNotAllowed: "Comment: not allowed",

  createMachine: "Create sandbox",
  restartMachine: "Restart sandbox",
  createFreshMachine: "Create sandbox (fresh)",
  retryCreate: "Retry create",
  discardMachine: "Discard sandbox",
  prepareWorkspace: "Prepare workspace",
  saveMachine: "Save sandbox",
  snapshotMachine: "Snapshot sandbox",
  cleanUpMachines: "Clean up sandboxes",
  cleanUpSnapshots: "Clean up snapshots",

  /** A captured command's one step: it runs and returns its output at once. */
  runAndReadOutput: "Run and read output",
  startProcess: "Start process",
  pollProcess: "Poll process",
  readOutput: "Read output",
  stopProcess: "Stop process",
  stopAfterTimeout: "Stop after timeout",
  findStartedProcess: "Find started process",

  checkCache: "Check cache",
  lookUpCache: "Look up cache",
  resolveCacheName: "Resolve cache name",
  deleteBadSnapshot: "Delete bad snapshot",
  checkSnapshotState: "Check snapshot state",

  cloneRepository: "Clone repository",
  uploadWorkingTree: "Upload working tree",
  findChangedFiles: "Find changed files",

  recordStartTime: "Record start time",
  recordEndTime: "Record end time",
  recordRunDetails: "Record run details",
  addSummary: "Add summary",
  addAnnotations: "Add annotations",
};
