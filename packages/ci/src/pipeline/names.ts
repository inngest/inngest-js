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

import type { CheckConclusion, JobConfig } from "../types.ts";
import { boundedName, formatDuration } from "../util.ts";
import { version } from "../version.ts";
import type { StepTag } from "./metadata.ts";
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
  job: (config: JobConfig, path: string): SpanInfo => {
    return userSpan("job", path, traceName.job(config, path));
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
          "$",
          joinId(stepId, statement.suffix),
          `${name} (${statement.label})`,
        )
      : userSpan("$", stepId, name);
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

/** What one of CI's own steps is: its ID, name, and what it's marked with. */
export interface StepSpec {
  /** The step's ID, which replays depend on. */
  id: string;
  /** What the step is called in the trace. */
  name: string;
  /** What the step is for, when it belongs to a job, a check or the cache. */
  tag?: StepTag;
  /**
   * Set for a step that CI's origin shouldn't mark: something you called, or a
   * step inside a span that already carries it.
   */
  unmarked?: true;
}

/**
 * A step CI runs for you where no span of CI's marks it, such as a command's
 * `Start process` inside the command's span, which is yours.
 */
export const ciStep = (id: string, name: string) => {
  return { id, name, ...originOption(ciOrigin) };
};

/** The step options for a spec, marked as CI's work unless it says not. */
export const stepOptions = (spec: StepSpec) => {
  return spec.unmarked
    ? { id: spec.id, name: spec.name }
    : ciStep(spec.id, spec.name);
};

/** How a finished check reads, as in `Report test: passed`. */
const outcomes: Partial<Record<CheckConclusion, string>> = {
  success: "passed",
  failure: "failed",
  timed_out: "timed out",
};

/** A check update's name, as in `Report test: started`. */
const report = (subject: string, status: string): string => {
  return `Report ${subject}: ${status}`;
};

/** A retry's name, as in `retrying (attempt 2 of 3)`. */
const retrying = (attempt: number, of: number): string => {
  return `retrying (attempt ${attempt} of ${of})`;
};

const cacheTag = (job: string): StepTag => {
  return { kind: "cache", job };
};

const checkTag = (job?: string): StepTag => {
  return job === undefined ? { kind: "check" } : { kind: "check", job };
};

/** The ID of a step of a cleanup, which a retried cleanup repeats. */
const cleanupId = (what: string, attempt: number): string => {
  return joinId(
    "pipeline",
    `${what}${attempt > 0 ? ` (attempt ${attempt})` : ""}`,
  );
};

/** The rest of a spec, once its ID and name are known. */
type StepExtras = Omit<StepSpec, "id" | "name">;

/** A step with a fixed name, whose ID the caller makes. */
const named = (name: string, extras: StepExtras = {}) => {
  return (id: string): StepSpec => {
    return { id, name, ...extras };
  };
};

/** A step with a fixed ID and name. */
const fixed = (id: string, name: string, extras: StepExtras = {}) => {
  return (): StepSpec => {
    return { id, name, ...extras };
  };
};

/**
 * Every step CI runs for you: its ID, name and tag, in one place. Adding a
 * step or renaming one is an edit to its entry here, and the step itself is
 * `ciRun(run, steps.x(...), fn)`. Steps that CI's origin shouldn't mark are
 * `unmarked`.
 */
export const steps = {
  // Jobs of other apps.
  buildAppJob: (id: string, name: string): StepSpec => {
    return { id, name: `Build ${name} in its app` };
  },

  findDeployedRepo: (): StepSpec => {
    return { id: joinId("deploy", "repo"), name: "Find deployed repository" };
  },

  // The cache.
  cacheKey: (jobPath: string): StepSpec => {
    return {
      id: joinId(jobPath, "cache:key"),
      name: "Check cache",
      tag: cacheTag(jobPath),
    };
  },

  lookUpCache: (id: string, jobPath: string): StepSpec => {
    return { id, name: "Look up cache", tag: cacheTag(jobPath) };
  },

  resolveCacheName: named("Resolve cache name"),
  checkSnapshotState: named("Check snapshot state"),
  deleteBadSnapshot: named("Delete bad snapshot"),
  deleteReplacedCache: named("Delete replaced cache"),

  // Sandboxes.
  discardMachine: (stepId: string): StepSpec => {
    return {
      id: joinId(stepId, "discard"),
      name: "Discard sandbox",
      unmarked: true,
    };
  },

  recordCommandFailure: (stepId: string, exitCode: number): StepSpec => {
    return {
      id: joinId(stepId, "exit"),
      name: `Exited with code ${exitCode}`,
    };
  },

  cleanUpMachines: (attempt: number): StepSpec => {
    return { id: cleanupId("cleanup", attempt), name: "Clean up sandboxes" };
  },

  cleanUpEndedRun: fixed("destroy-orphans", "Clean up sandboxes"),

  cleanUpSnapshots: (attempt: number): StepSpec => {
    return {
      id: cleanupId("cleanup:snapshots", attempt),
      name: "Clean up snapshots",
    };
  },

  // Checking out.
  uploadWorkingTree: named("Upload working tree", { unmarked: true }),
  cloneRepository: named("Clone repository", { unmarked: true }),
  findChangedFiles: fixed("changed", "Find changed files", { unmarked: true }),

  // What you called on a run.
  githubHelper: (id: string, helper: string, name = `github.${helper}`) => {
    return { id, name, unmarked: true } satisfies StepSpec;
  },

  githubCall: (id: string, label: string, name = label) => {
    return { id, name, unmarked: true } satisfies StepSpec;
  },

  addSummary: named("Add summary", { unmarked: true }),
  addAnnotations: named("Add annotations", { unmarked: true }),

  // Reading from GitHub.
  resolveRepository: (): StepSpec => {
    return {
      id: joinId("github", "repo:resolve"),
      name: "Resolve repository",
      unmarked: true,
    };
  },

  resolvePullRequest: (): StepSpec => {
    return {
      id: joinId("github", "pr:resolve"),
      name: "pr:resolve",
      unmarked: true,
    };
  },

  resolveRef: (key: string): StepSpec => {
    return {
      id: boundedName(joinId("github", `ref:${key}`)),
      name: "Resolve ref",
    };
  },

  commentNotAllowed: (): StepSpec => {
    return {
      id: joinId("github", "comment:denied"),
      name: "Comment: not allowed",
      unmarked: true,
    };
  },

  // Checks.
  startCheck: (check: string, job?: string): StepSpec => {
    return {
      id: joinId("github", `check:${job ?? check}:start`),
      name:
        job === undefined ? `Create check: ${check}` : report(job, "started"),
      tag: checkTag(job),
      unmarked: true,
    };
  },

  completeCheck: (
    check: string,
    job?: { path: string; conclusion: CheckConclusion },
  ): StepSpec => {
    return {
      id: joinId("github", `check:${job?.path ?? check}:complete`),
      name: job
        ? report(job.path, outcomes[job.conclusion] ?? job.conclusion)
        : `Complete check: ${check}`,
      tag: checkTag(job?.path),
      unmarked: true,
    };
  },

  completeJobChecks: (): StepSpec => {
    return {
      id: joinId("github", "check:jobs:complete"),
      name: report("jobs", "ended with the run"),
      tag: checkTag(),
      unmarked: true,
    };
  },

  retryCheck: (
    check: string,
    attempt: number,
    of: number,
    job?: string,
  ): StepSpec => {
    return {
      id: joinId("github", `check:${job ?? "pipeline"}:retry:${attempt}`),
      name: report(job ?? check, retrying(attempt + 2, of)),
      tag: checkTag(job),
      unmarked: true,
    };
  },

  retryJobChecks: (attempt: number, of: number): StepSpec => {
    return {
      id: joinId("github", `check:jobs:retry:${attempt}`),
      name: report("jobs", retrying(attempt + 2, of)),
      tag: checkTag(),
      unmarked: true,
    };
  },

  failedAttempt: (job: string, attempt: number, of: number): StepSpec => {
    return {
      id: joinId("github", `check:${job}:attempt:${attempt}`),
      name: report(job, retrying(attempt + 1, of)),
      unmarked: true,
    };
  },

  buildingCheck: (job: string): StepSpec => {
    return {
      id: joinId("github", `check:${job}:building`),
      name: report(job, "building"),
      unmarked: true,
    };
  },

  // Times and run details, for steps that carry nothing else.
  recordTime: (
    id: string,
    job: string,
    edge: "started" | "ended",
  ): StepSpec => {
    return {
      id,
      name: edge === "started" ? "Record start time" : "Record end time",
      tag: { kind: "job", job },
    };
  },

  recordRunDetails: named("Record run details"),
};

export const traceName = {
  /**
   * A job's span: its `name`, or its path when it has none. A later direct
   * call, whose path is `${id} (n)`, keeps its `(n)` after the name.
   */
  job: (config: JobConfig, path: string): string => {
    if (!config.name) {
      return path;
    }

    return `${config.name}${path.slice(config.id.length)}`;
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
    return label ?? text;
  },

  attempt: (attempt: number): string => {
    return `Attempt ${attempt}`;
  },

  wait: (ms: number): string => {
    return `Wait ${formatDuration(ms)}`;
  },

  buildInOwnRun: (path: string): string => {
    return `Build ${path} in its own run`;
  },

  runInOwnRun: (path: string): string => {
    return `Run ${path} in its own run`;
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

  createMachine: "Create sandbox",
  restartMachine: "Restart sandbox",
  createFreshMachine: "Create sandbox (fresh)",
  retryCreate: "Retry create",
  prepareWorkspace: "Prepare workspace",
  saveMachine: "Save sandbox",
  snapshotMachine: "Snapshot sandbox",

  /** A captured command's one step: it runs and returns its output at once. */
  runAndReadOutput: "Run and read output",
  startProcess: "Start process",
  pollProcess: "Poll process",
  readOutput: "Read output",
  stopProcess: "Stop process",
  stopAfterTimeout: "Stop after timeout",
  findStartedProcess: "Find started process",
};
