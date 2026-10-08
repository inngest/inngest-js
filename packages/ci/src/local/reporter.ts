/**
 * Telling the `inngest-ci` CLI what the app defines and how a run is going.
 * Every report is a {@link LocalMessage} posted to `INNGEST_CI_REPORTER_URL`;
 * without it, nothing is sent. Reporting never blocks or fails a run.
 *
 * @module
 */

import type { CheckSink } from "../github/checks.ts";
import type {
  CiHooks,
  CommandAttempt,
  LocalStatus,
} from "../pipeline/hooks.ts";
import type { CiJobScope, CiRunScope } from "../pipeline/scope.ts";
import type { CheckConclusion, CommandResult } from "../types.ts";
import type { LocalManifest, LocalMessage } from "./protocol.ts";
import { localEnv } from "./protocol.ts";

/** Whether `inngest-ci` started this app. Read on use, like the client's mode. */
export const isLocal = (): boolean => {
  return process.env[localEnv.local] === "1";
};

/** How many lines of a finished command's output the CLI is sent. */
const outputTailLines = 20;

/** How long one message may take to deliver before it's dropped. */
const sendTimeoutMs = 2000;

/** The check key of the pipeline itself. A job's key is its path. */
const pipelineKey = "pipeline";

const statusForConclusion: Record<CheckConclusion, LocalStatus> = {
  success: "passed",
  failure: "failed",
  neutral: "skipped",
  cancelled: "cancelled",
  timed_out: "failed",
  action_required: "failed",
  skipped: "skipped",
  stale: "cancelled",
};

type CommandMessage = Extract<LocalMessage, { kind: "command" }>;

export interface LocalReporter extends CiHooks {
  /**
   * Send the manifest once the current turn of the event loop is over, so
   * every module has finished defining things. `build` runs then.
   */
  manifest(build: () => LocalManifest): void;
}

/**
 * The run a message is filed under. A cache build reports to the run that
 * invoked it, so its jobs and commands show under that run's job.
 */
const reportedRunId = (run: CiRunScope): string => {
  return run.build?.parent.runId ?? run.runId;
};

/** A check's external ID is `<runId>:<key>`. */
const checkKey = (args: { run: CiRunScope; externalId: string }): string => {
  return args.externalId.slice(args.run.runId.length + 1);
};

/**
 * Create a reporter. Each client has its own, so what one has already sent
 * doesn't leak into another.
 */
export const createLocalReporter = (): LocalReporter => {
  const sent = new Set<string>();

  let queue: Promise<unknown> = Promise.resolve();

  const reporterUrl = () => {
    return process.env[localEnv.reporterUrl];
  };

  const send = (message: LocalMessage): void => {
    const url = reporterUrl();

    if (!url) {
      return;
    }

    // Handlers replay from the top on every step, so the same transition is
    // reported again and again. The CLI only needs it once.
    const key = JSON.stringify(message, (field, value) => {
      return field === "at" || field === "outputTail" ? undefined : value;
    });

    if (sent.has(key)) {
      return;
    }

    sent.add(key);

    // One at a time, so messages arrive in the order they were sent.
    queue = queue
      .then(() => {
        return fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(sendTimeoutMs),
        });
      })
      .catch(() => {
        // Reporting is best effort.
      });
  };

  const reportCheck = (
    run: CiRunScope,
    key: string,
    status: LocalStatus,
    detailsUrl: string,
    title?: string,
  ): void => {
    if (key === pipelineKey) {
      send({
        kind: "run",
        runId: run.runId,
        eventId: (run.event as { id?: string } | undefined)?.id ?? "",
        pipelineId: run.pipelineId,
        status,
        ...(title && status !== "passed" ? { reason: title } : {}),
        url: detailsUrl,
        at: Date.now(),
      });

      return;
    }

    send({
      kind: "job",
      runId: run.runId,
      jobId: key,
      status,
      ...(title ? { title } : {}),
      at: Date.now(),
    });
  };

  const reportCommand = (
    scope: CiJobScope,
    command: CommandAttempt,
    fields: Pick<CommandMessage, "status"> & Partial<CommandMessage>,
  ): void => {
    send({
      kind: "command",
      runId: reportedRunId(scope.run),
      jobId: scope.jobPath,
      commandId: command.id,
      name: command.name,
      attempt: command.attempt,
      at: Date.now(),
      ...fields,
    });
  };

  return {
    manifest: (build) => {
      if (!reporterUrl()) {
        return;
      }

      setImmediate(() => {
        send({ kind: "manifest", manifest: build() });
      });
    },

    wrapSink: (sink) => {
      return {
        ...sink,

        start: (args) => {
          reportCheck(args.run, checkKey(args), "running", args.detailsUrl);

          return sink.start(args);
        },

        complete: (args) => {
          const key = checkKey(args);

          const cached = args.run.summaries.some((summary) => {
            return summary.path === key && summary.cached;
          });

          reportCheck(
            args.run,
            key,
            cached ? "cached" : statusForConclusion[args.conclusion],
            args.detailsUrl,
            args.title,
          );

          return sink.complete(args);
        },
      };
    },

    jobFrom: (scope, parentId) => {
      // A build run's jobs aren't rows of the run it reports to.
      if (scope.run.build) {
        return;
      }

      send({
        kind: "job",
        runId: scope.run.runId,
        jobId: scope.jobPath,
        status: "running",
        parentId,
        at: Date.now(),
      });
    },

    jobRunUrl: (run, jobId, url) => {
      send({
        kind: "job",
        runId: reportedRunId(run),
        jobId,
        status: "running",
        url,
        at: Date.now(),
      });
    },

    jobEnded: (run, jobId, status, title) => {
      send({
        kind: "job",
        runId: reportedRunId(run),
        jobId,
        status,
        ...(title ? { title } : {}),
        at: Date.now(),
      });
    },

    activity: (run, jobId, text) => {
      send({
        kind: "activity",
        runId: reportedRunId(run),
        jobId,
        text,
        at: Date.now(),
      });
    },

    warnings: (run) => {
      // A build run's warnings reach the run that invoked it in its result.
      if (run.build) {
        return;
      }

      for (const text of run.warnings) {
        send({ kind: "warning", runId: run.runId, text, at: Date.now() });
      }
    },

    commandStarted: (scope, command) => {
      reportCommand(scope, command, { status: "running" });
    },

    commandFinished: (scope, command, result) => {
      const outputTail = `${result.stdout}\n${result.stderr}`
        .trim()
        .split("\n")
        .slice(-outputTailLines)
        .join("\n");

      reportCommand(scope, command, {
        status: result.exitCode === 0 ? "passed" : "failed",
        exitCode: result.exitCode,
        ...(result.durationMs === undefined
          ? {}
          : { durationMs: result.durationMs }),
        ...(outputTail ? { outputTail } : {}),
      });
    },
  };
};
