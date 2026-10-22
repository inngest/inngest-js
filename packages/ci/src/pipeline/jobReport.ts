/**
 * What a job's check shows, worked out from the job's scope and how it ended:
 * the links, the machine, the failure's class and excerpt, and the payload for
 * each state. The wording itself lives in `github/render`.
 *
 * @module
 */

import { getSandboxError } from "inngest/experimental";
import { CommandFailedError, CommandTimeoutError } from "../errors.ts";
import type {
  ExcerptLine,
  JobContext,
  JobFailure,
} from "../github/render/job.ts";
import { jobCheck } from "../github/render/job.ts";
import type { CheckLinks, CheckPayload } from "../github/render/types.ts";
import { omittedNote, shapeAnnotations } from "../report/annotations.ts";
import {
  classifyCommand,
  infraSignal,
  testCounts,
  tscDiagnostic,
} from "../report/classify.ts";
import type { CheckAnnotation } from "../types.ts";
import {
  errorMessage,
  failureLine,
  formatRelative,
  shortReason,
  stripAnsi,
} from "../util.ts";
import { cacheBuildFunctionId } from "./cacheBuild.ts";
import type { CiJobScope, CiRunScope } from "./scope.ts";
import { defaultCwd, joinId } from "./scope.ts";

const github = "https://github.com";

/** The links every state of a run's checks can offer. */
export const runLinks = (run: CiRunScope): CheckLinks => {
  const repo = run.repo;

  return {
    run: run.ci.runUrl({ runId: run.runId, functionId: run.functionId }),
    ...(repo?.sha
      ? {
          commit: {
            sha: repo.sha.slice(0, 7),
            url: `${github}/${repo.fullName}/commit/${repo.sha}`,
          },
        }
      : {}),
    ...(repo?.pullRequest
      ? {
          pullRequest: {
            number: repo.pullRequest.number,
            url: `${github}/${repo.fullName}/pull/${repo.pullRequest.number}`,
          },
        }
      : {}),
  };
};

/** A link to a line of a file at the run's commit. */
const blobUrl = (run: CiRunScope, path: string, line: number): string => {
  const repo = run.repo;

  return repo?.sha
    ? `${github}/${repo.fullName}/blob/${repo.sha}/${path}#L${line}`
    : "";
};

/** The machine a job runs on, as in `4 vCPU, 4 GiB`. Memory follows vCPU. */
export const machineText = (scope: CiJobScope): string => {
  const vcpu =
    scope.config.machine?.vcpu ??
    scope.run.machine?.vcpu ??
    scope.run.ci.defaultMachine?.vcpu ??
    4;

  return `${vcpu} vCPU, ${vcpu} GiB`;
};

/** What every state of a job's check knows. */
export const jobContext = (
  scope: CiJobScope,
  elapsedMs?: number,
): JobContext => {
  const parent = scope.fromParent?.id;
  const saved = parent ? scope.run.cacheSaved.get(parent) : undefined;

  return {
    ...runLinks(scope.run),
    name: scope.config.id,
    machine: machineText(scope),
    commands: [...scope.commands],
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(parent ? { parent: { name: parent } } : {}),
    ...(scope.fromParent?.reused && saved ? { savedMs: saved } : {}),
  };
};

/** The check of a job that is running, as it stands. */
export const runningPayload = (
  scope: CiJobScope,
  elapsedMs?: number,
): CheckPayload => {
  return jobCheck({
    ...jobContext(scope, elapsedMs),
    state: { kind: "running" },
  });
};

/**
 * Show a job's check as it stands, in a step of its own. Each call is named by
 * how many came before it in the job, so replays name them the same.
 */
export const reportProgress = async (
  run: CiRunScope,
  jobPath: string,
  payload: () => CheckPayload,
): Promise<void> => {
  const base = joinId("github", `check:${jobPath}:progress`);
  const count = (run.counters.get(base) ?? 0) + 1;

  run.counters.set(base, count);

  await run.ci.checks?.jobProgress?.({ run, jobPath, count, payload });
};

/** The check of a job that waits on a build, which may be in another run. */
export const waitingBuildPayload = (
  run: CiRunScope,
  jobPath: string,
  build: string,
): CheckPayload => {
  return jobCheck({
    ...runLinks(run),
    name: jobPath,
    state: { kind: "waiting-build", build },
  });
};

/** The check of a job that is known and has not started. */
export const queuedPayload = (scope: CiJobScope): CheckPayload => {
  const from = (scope.config.from as { id?: unknown } | undefined)?.id;

  return jobCheck({
    ...jobContext(scope),
    state: {
      kind: "queued",
      ...(typeof from === "string" ? { waitingFor: { name: from } } : {}),
    },
  });
};

/** The check of a job that passed. */
export const passedPayload = (
  scope: CiJobScope,
  elapsedMs: number,
): CheckPayload => {
  return jobCheck({
    ...jobContext(scope, elapsedMs),
    state: { kind: "passed" },
  });
};

/** How a job that restored its snapshot reads. */
export const cacheHitPayload = (
  scope: CiJobScope,
  cached: { snapshotId: string; name: string; createdAt: string },
  built?: { durationMs: number },
): CheckPayload => {
  const builtMs = built?.durationMs;

  return jobCheck({
    ...jobContext(scope),
    ...(builtMs === undefined ? {} : { savedMs: builtMs }),
    state: {
      kind: "cache-hit",
      restoredMs: 0,
      ...(builtMs === undefined ? {} : { builtMs }),
      builtAgo: formatRelative(cached.createdAt),
      entry: cached.name,
      snapshot: cached.snapshotId,
    },
  });
};

/** The lines of an output worth showing: from the first error onward. */
const excerptOf = (output: string): ExcerptLine[] => {
  const lines = stripAnsi(output)
    .split("\n")
    .map((line) => {
      return line.trimEnd();
    })
    .filter((line) => {
      return /\S/.test(line);
    });

  const first = lines.findIndex((line) => {
    return /Error|\bFAIL\b|error TS|not found|timed out/.test(line);
  });

  const start = first === -1 ? Math.max(0, lines.length - 6) : first;

  return lines.slice(start, start + 8).map((line) => {
    return {
      text: line.length > 200 ? `${line.slice(0, 199)}…` : line,
      bad: /Error|\bFAIL\b|error TS|not found|timed out/.test(line),
    };
  });
};

/** `src/a.ts:42` style places in an output, mapped to the repository. */
const placesOf = (
  scope: CiJobScope,
  output: string,
): Array<{ label: string; url: string }> => {
  const cwd = scope.cwd ?? defaultCwd;
  const base = cwd === defaultCwd ? "" : cwd.replace(`${defaultCwd}/`, "");
  const places = new Map<string, { label: string; url: string }>();

  const add = (file: string, line: number) => {
    const path = file.startsWith(`${defaultCwd}/`)
      ? file.slice(defaultCwd.length + 1)
      : file.startsWith("/")
        ? undefined
        : [base, file.replace(/^\.\//, "")].filter(Boolean).join("/");

    if (!path || places.size >= 3) {
      return;
    }

    const url = blobUrl(scope.run, path, line);

    if (url) {
      places.set(`${path}:${line}`, {
        label: `\`${path.split("/").at(-1)}:${line}\``,
        url,
      });
    }
  };

  for (const match of output.matchAll(tscDiagnostic)) {
    add(match[1] ?? "", Number(match[2]));
  }

  for (const match of output.matchAll(
    /(?:❯|at |\()\s*([^\s():]+\.[cm]?[tj]sx?):(\d+)(?::\d+)?/g,
  )) {
    add(match[1] ?? "", Number(match[2]));
  }

  return [...places.values()];
};

const plural = (count: number, word: string): string => {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
};

const commandText = (command: string[]): string => {
  return command.join(" ");
};

/** A command's failure, told in the class it is. */
const commandFailure = (
  scope: CiJobScope,
  error: CommandFailedError,
): JobFailure => {
  const output = stripAnsi(
    error.mergedTail ?? `${error.stderrTail}\n${error.stdoutTail}`,
  );

  const errorClass =
    error.errorClass ??
    classifyCommand({
      exitCode: error.exitCode,
      stdout: error.stdoutTail,
      stderr: error.stderrTail,
    });

  const command = commandText(error.command);
  const exit = `(exit ${error.exitCode})`;
  const open = placesOf(scope, output);
  const excerpt = excerptOf(output);
  const log = output.split("\n").slice(-120).join("\n");
  const reason = failureReason(error);

  switch (errorClass) {
    case "test": {
      const counts = testCounts(output);

      return {
        errorClass,
        title: `${plural(counts?.failed ?? 1, "test")} failed: ${reason}`,
        headline: `**${plural(counts?.failed ?? 1, "test")} failed**${counts ? `, ${counts.passed} passed` : ""}, in \`${command}\` ${exit}.`,
        open,
        excerpt,
        log,
      };
    }

    case "code": {
      const count = [...output.matchAll(tscDiagnostic)].length;

      return {
        errorClass,
        title: `${reason} ${exit}`,
        headline: `**${plural(count, "type error")}** in \`${command}\` ${exit}.`,
        open,
        excerpt,
        log,
      };
    }

    case "infra": {
      const signal = infraSignal(output);
      const noTests = /No test files found/i.test(output);

      return {
        errorClass,
        title: `${reason} ${exit}`,
        headline: `**Probably infrastructure, not your change.** ${signal ? signal.reason.replace(/^./, (first) => first.toUpperCase()) : "The failure looks like a platform problem"}${noTests ? ", so **no test ran**" : ""}.`,
        excerpt,
        log,
        notes: /close timed out/.test(output)
          ? [
              "The `close timed out` line further down is the test runner cleaning up after this, not a second problem.",
            ]
          : [],
      };
    }

    case "oom":
      return {
        errorClass,
        title: `${reason} ${exit}`,
        headline: `**Killed, probably out of memory.** \`${command}\` ${exit}. A bigger machine size may help.`,
        excerpt,
        log,
      };

    case "signal":
      return {
        errorClass,
        title: `\`${command}\` was stopped ${exit}`,
        headline: `**Stopped by a signal.** \`${command}\` ${exit}, usually SIGTERM.`,
        excerpt,
        log,
      };

    case "timeout":
      return {
        errorClass,
        title: `\`${command}\` was stopped by timeout ${exit}`,
        headline: `**Timed out.** \`${command}\` ${exit} is what timeout(1) exits with.`,
        excerpt,
        log,
      };

    default:
      return {
        errorClass,
        title: reason
          ? `${reason} ${exit}`
          : `\`${command}\` exited with ${error.exitCode}`,
        headline: `**\`${command}\` failed** ${exit}.`,
        open,
        excerpt,
        log,
      };
  }
};

/** The line of a command's output that says why it failed, for a title. */
const failureReason = (error: CommandFailedError): string => {
  return failureLine(error.stderrTail, error.stdoutTail);
};

/** How a job's error is told on its check. */
export const failureOf = (error: unknown, scope: CiJobScope): JobFailure => {
  if (error instanceof CommandFailedError) {
    return {
      ...commandFailure(scope, error),
      ...(error.stepId ? { stepId: error.stepId } : {}),
    };
  }

  if (error instanceof CommandTimeoutError) {
    const command = commandText(error.command);

    return {
      errorClass: "timeout",
      title: `Timed out: \`${command}\` ran past its ${error.timeout} limit`,
      headline: `**Timed out.** \`${command}\` was stopped after ${error.timeout}.`,
      ...(error.stepId ? { stepId: error.stepId } : {}),
    };
  }

  const sandboxError = getSandboxError(error);

  if (sandboxError) {
    const reason = shortReason(error) || sandboxError.code;

    return {
      errorClass: "sandbox",
      title: `Sandbox error: ${reason}`,
      headline: `**Not your change.** The sandbox service reported \`${sandboxError.code}\`, so **no command ran**.`,
      excerpt: [{ text: errorMessage(error).split("\n")[0] ?? "", bad: true }],
    };
  }

  const reason = shortReason(error) || "Failed";

  return {
    errorClass: "failure",
    title: reason,
    headline: `**${reason}.**`,
    excerpt: errorMessage(error)
      .split("\n")
      .slice(0, 6)
      .map((text) => {
        return { text, bad: true };
      }),
  };
};

/** The check of a job that failed or timed out, and how it failed. */
export const failedPayload = (
  scope: CiJobScope,
  error: unknown,
  elapsedMs: number,
): { payload: CheckPayload; failure: JobFailure } => {
  const failure = failureOf(error, scope);

  return {
    failure,
    payload: jobCheck({
      ...jobContext(scope, elapsedMs),
      state: { kind: "failed", failure },
    }),
  };
};

/**
 * What a job's check is completed with: the payload, with what the job's own
 * code reported through `report.summary` below it.
 */
export const withReports = (
  payload: CheckPayload,
  scope: CiJobScope,
): {
  title: string;
  summary: string;
  text?: string;
  actions: CheckPayload["actions"];
  annotations: CheckAnnotation[];
} => {
  const shaped = shapeAnnotations(scope.annotations, scope.found);
  const left = omittedNote(shaped);

  return {
    title: payload.title,
    summary: [
      payload.summary,
      ...(left ? [left] : []),
      ...scope.summaries,
    ].join("\n\n"),
    ...(payload.text === undefined ? {} : { text: payload.text }),
    actions: payload.actions,
    annotations: shaped.annotations,
  };
};
