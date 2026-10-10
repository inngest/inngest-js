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

import type { CachedSnapshot } from "../cache/cache.ts";
import type { CheckConclusion, RepoContext } from "../types.ts";
import { formatDuration, truncateLabel } from "../util.ts";
import { version } from "../version.ts";
import type { StepTag } from "./metadata.ts";
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
  job: (run: CiRunScope, path: string, name?: string): SpanInfo => {
    return userSpan("job", path, name ?? traceName.job(run, path));
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

/** What a step of CI's own says about itself, in one catalog entry. */
export interface StepSpec<T = unknown> {
  /** The step's ID, which replays depend on. */
  id: string;
  /** What the step is called in the trace. */
  name: string;
  /** A short sentence for what the step sets out to do. */
  intent: string;
  /** What the step is for, when it belongs to a job, a check or the cache. */
  tag?: StepTag;
  /**
   * What happened, in a few small fields: a record, or a function of what the
   * step returned. A step that throws records its error's first line beside a
   * record, and alone beside a function.
   */
  outcome?: Record<string, unknown> | ((result: T) => Record<string, unknown>);
  /** Set for a step of something you called, which isn't marked as CI's work. */
  yours?: true;
}

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

/** What a checkout leaves: where the files are, and the commit for a clone. */
interface CheckedOut {
  path: string;
  source: string;
  sha?: string;
}

const checkedOut = ({ path, source, sha }: CheckedOut) => {
  return { path, source, sha };
};

/**
 * Every step CI runs for you: its ID, name, intent, tag and outcome, in one
 * place. Adding a step, renaming one or rewording what it says is an edit to
 * its entry here, and the step itself is `ciRun(run, steps.x(...), fn)`.
 * Steps of what you called are marked `yours`, so they carry no CI origin.
 */
export const steps = {
  // The cache.
  cacheKey: (jobPath: string, jobId: string): StepSpec<string> => {
    return {
      id: joinId(jobPath, "cache:key"),
      name: "Check cache",
      intent: `Work out the cache key for \`${jobId}\``,
      tag: cacheTag(jobPath),
      outcome: (key) => {
        return { key };
      },
    };
  },

  lookUpCache: (
    id: string,
    jobId: string,
    jobPath: string,
  ): StepSpec<CachedSnapshot | null> => {
    return {
      id,
      name: "Look up cache",
      intent: `Look up the cached snapshot for \`${jobId}\``,
      tag: cacheTag(jobPath),
      outcome: (hit) => {
        return hit
          ? { found: true, snapshotId: hit.snapshotId, name: hit.name }
          : { found: false };
      },
    };
  },

  resolveCacheName: (
    id: string,
    name: string,
  ): StepSpec<{ winner?: CachedSnapshot; cleared: boolean }> => {
    return {
      id,
      name: "Resolve cache name",
      intent: `Find who holds the snapshot name \`${truncateLabel(name, 80)}\``,
      outcome: ({ winner, cleared }) => {
        return { winner: winner?.snapshotId, cleared };
      },
    };
  },

  checkSnapshotState: (id: string, snapshotId: string): StepSpec<string> => {
    return {
      id,
      name: "Check snapshot state",
      intent: `Check the state of snapshot \`${snapshotId}\``,
      outcome: (state) => {
        return { snapshotId, state };
      },
    };
  },

  deleteBadSnapshot: (
    id: string,
    snapshotId: string,
  ): StepSpec<{ deleted: boolean; gone: boolean }> => {
    return {
      id,
      name: "Delete bad snapshot",
      intent: `Delete the bad snapshot \`${snapshotId}\``,
      outcome: ({ deleted, gone }) => {
        return { snapshotId, deleted, gone };
      },
    };
  },

  // Sandboxes.
  discardMachine: (
    stepId: string,
    machine: string,
  ): StepSpec<{ id?: string }> => {
    return {
      id: joinId(stepId, "discard"),
      name: "Discard sandbox",
      intent: `Discard the sandbox \`${machine}\` that failed to start`,
      outcome: ({ id }) => {
        return { discarded: Boolean(id), sandboxId: id };
      },
    };
  },

  recordCommandFailure: (stepId: string, exitCode: number): StepSpec => {
    return {
      id: joinId(stepId, "exit"),
      name: `Exited with code ${exitCode}`,
      intent: "Record that the command failed",
      outcome: { exitCode },
    };
  },

  cleanUpMachines: (attempt: number): StepSpec<{ destroyed: number }> => {
    return {
      id: cleanupId("cleanup", attempt),
      name: "Clean up sandboxes",
      intent: "Destroy this run's sandboxes",
      outcome: ({ destroyed }) => {
        return { destroyed };
      },
    };
  },

  cleanUpEndedRun: (): StepSpec<{ destroyed: number }> => {
    return {
      id: "destroy-orphans",
      name: "Clean up sandboxes",
      intent: "Destroy the sandboxes of a run that ended",
      outcome: ({ destroyed }) => {
        return { destroyed };
      },
    };
  },

  cleanUpSnapshots: (
    attempt: number,
  ): StepSpec<{ deleted: string[]; failed: string[] }> => {
    return {
      id: cleanupId("cleanup:snapshots", attempt),
      name: "Clean up snapshots",
      intent: "Delete the snapshots this run took",
      outcome: ({ deleted, failed }) => {
        return { deleted: deleted.length, failed: failed.length };
      },
    };
  },

  // Checking out.
  uploadWorkingTree: (id: string, target: string): StepSpec<CheckedOut> => {
    return {
      id,
      name: "Upload working tree",
      intent: `Upload the working tree to \`${target}\``,
      outcome: checkedOut,
      yours: true,
    };
  },

  cloneRepository: (
    id: string,
    repository: string,
    target: string,
  ): StepSpec<CheckedOut> => {
    return {
      id,
      name: "Clone repository",
      intent: `Clone \`${repository}\` into \`${target}\``,
      outcome: checkedOut,
      yours: true,
    };
  },

  findChangedFiles: (): StepSpec<string[] | { unknown: true }> => {
    return {
      id: "changed",
      name: "Find changed files",
      intent: "Find the files this change touched",
      outcome: (files) => {
        return Array.isArray(files)
          ? { count: files.length }
          : { count: null, unknown: true };
      },
      yours: true,
    };
  },

  // What you called on a run.
  githubHelper: (
    id: string,
    helper: string,
    key: string,
    name = `github.${helper}`,
  ): StepSpec => {
    return {
      id,
      name,
      intent: `Call \`github.${helper}\``,
      outcome: { helper, key },
      yours: true,
    };
  },

  githubCall: (id: string, label: string, name = label): StepSpec => {
    return {
      id,
      name,
      intent: `Call \`${label}\` on GitHub`,
      outcome: { call: label },
      yours: true,
    };
  },

  addSummary: (id: string): StepSpec<{ length: number }> => {
    return {
      id,
      name: "Add summary",
      intent: "Add a section to the check summary",
      outcome: ({ length }) => {
        return { length };
      },
      yours: true,
    };
  },

  addAnnotations: (id: string, count: number): StepSpec<{ count: number }> => {
    return {
      id,
      name: "Add annotations",
      intent: `Add ${count} annotations to the check`,
      outcome: (added) => {
        return { count: added.count };
      },
      yours: true,
    };
  },

  // Reading from GitHub.
  resolveRepository: (fullName: string): StepSpec<RepoContext> => {
    return {
      id: joinId("github", "repo:resolve"),
      name: "Resolve repository",
      intent: `Find the head commit of \`${fullName}\`'s default branch`,
      outcome: ({ sha, baseRef }) => {
        return sha
          ? { resolved: true, branch: baseRef, sha }
          : { resolved: false };
      },
    };
  },

  resolvePullRequest: (number: number | undefined): StepSpec<RepoContext> => {
    return {
      id: joinId("github", "pr:resolve"),
      name: "pr:resolve",
      intent: `Find the head and base of pull request #${number ?? "?"}`,
      outcome: ({ sha, baseRef, baseSha, pullRequest }) => {
        return baseSha
          ? { resolved: true, sha, baseRef, fork: pullRequest?.fork }
          : { resolved: false };
      },
    };
  },

  commentNotAllowed: (login: string, permission: string): StepSpec => {
    return {
      id: joinId("github", "comment:denied"),
      name: "Comment: not allowed",
      intent: `Tell ${login} they need \`${permission}\` permission`,
      outcome: { denied: login, needed: permission },
    };
  },

  resendTrigger: (): StepSpec<{ rerun: boolean }> => {
    return {
      id: "resend-trigger",
      name: "resend-trigger",
      intent: "Send the pipeline's trigger again for the re-requested check",
      outcome: (result) => {
        return result;
      },
    };
  },

  // Checks.
  startCheck: (check: string, job?: string): StepSpec<{ id?: number }> => {
    return {
      id: joinId("github", `check:${job ?? check}:start`),
      name:
        job === undefined ? `Create check: ${check}` : report(job, "started"),
      intent: `Start the check \`${check}\``,
      tag: checkTag(job),
      outcome: ({ id }) => {
        return { checkRunId: id };
      },
    };
  },

  completeCheck: (
    check: string,
    job?: { path: string; conclusion: CheckConclusion },
    /** What the check was told, once the step has read it. */
    result?: () =>
      | { conclusion: CheckConclusion; annotations?: unknown[] }
      | undefined,
  ): StepSpec => {
    return {
      id: joinId("github", `check:${job?.path ?? check}:complete`),
      name: job
        ? report(job.path, outcomes[job.conclusion] ?? job.conclusion)
        : `Complete check: ${check}`,
      intent: `Report \`${check}\`'s check`,
      tag: checkTag(job?.path),
      outcome: () => {
        const told = result?.();

        return {
          conclusion: told?.conclusion,
          annotations: told?.annotations?.length ?? 0,
        };
      },
    };
  },

  completeJobChecks: (): StepSpec<unknown[]> => {
    return {
      id: joinId("github", "check:jobs:complete"),
      name: report("jobs", "ended with the run"),
      intent: "Report the checks of jobs that ended with the run",
      tag: checkTag(),
      outcome: (closed) => {
        return { reported: closed.length };
      },
    };
  },

  retryCheck: (
    check: string,
    retry: { attempt: number; of: number; title: string },
    job?: string,
  ): StepSpec => {
    return {
      id: joinId("github", `check:${job ?? "pipeline"}:retry:${retry.attempt}`),
      name: report(job ?? check, retrying(retry.attempt + 2, retry.of)),
      intent: `Show on \`${check}\` that it's retrying`,
      tag: checkTag(job),
      outcome: { title: retry.title, attempt: retry.attempt + 2 },
    };
  },

  retryJobChecks: (retry: {
    attempt: number;
    of: number;
    title: string;
  }): StepSpec => {
    return {
      id: joinId("github", `check:jobs:retry:${retry.attempt}`),
      name: report("jobs", retrying(retry.attempt + 2, retry.of)),
      intent: "Show on the job checks that they're retrying",
      tag: checkTag(),
      outcome: { title: retry.title, attempt: retry.attempt + 2 },
    };
  },

  failedAttempt: (
    job: string,
    attempt: number,
    of: number,
    error: string,
  ): StepSpec => {
    return {
      id: joinId("github", `check:${job}:attempt:${attempt}`),
      name: report(job, retrying(attempt + 1, of)),
      intent: `Show on \`${job}\`'s check that attempt ${attempt} of ${of} failed`,
      outcome: { attempt, of, error },
    };
  },

  buildingCheck: (job: string, detailsUrl?: string): StepSpec => {
    return {
      id: joinId("github", `check:${job}:building`),
      name: report(job, "building"),
      intent: `Show on \`${job}\`'s check that it's building`,
      outcome: { detailsUrl },
    };
  },

  // Times and run details, for steps that carry nothing else.
  recordTime: (
    id: string,
    job: string,
    edge: "started" | "ended",
  ): StepSpec<number> => {
    return {
      id,
      name: edge === "started" ? "Record start time" : "Record end time",
      intent: `Record when \`${job}\` ${edge}`,
      tag: { kind: "job", job },
      outcome: (at) => {
        return { at: new Date(at).toISOString() };
      },
    };
  },

  checkBuildLock: (id: string, lock: string): StepSpec<boolean> => {
    return {
      id,
      name: "Check build",
      intent: `Check that the build holding \`${lock}\` is still going`,
      outcome: (alive) => {
        return { alive };
      },
    };
  },

  recordRunDetails: (id: string): StepSpec => {
    return {
      id,
      name: "Record run details",
      intent: "Record this run's details",
    };
  },
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

  buildInOwnRun: (path: string): string => {
    return `Build ${path} in its own run`;
  },

  buildInline: (jobId: string): string => {
    return `Build ${jobId} inline`;
  },

  askForBuild: (path: string): string => {
    return `Ask for a build of ${path}`;
  },

  waitForBuild: (path: string): string => {
    return `Wait for a build of ${path}`;
  },

  announceBuild: "Tell the runs waiting on a build",

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
