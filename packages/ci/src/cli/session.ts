/**
 * One `inngest-ci` run, start to finish: set up the Dev Server and the app,
 * send the event, watch the run through the app's messages, and clean up. It
 * only talks to the outside through `SessionEvent`s.
 *
 * @module
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type LocalMessage,
  type LocalStatus,
  runJobFunctionId,
} from "../local/protocol.ts";
import { devServerRunUrl, errorMessage } from "../util.ts";
import { startApp, waitForSync } from "./app.ts";
import type { CliArgs } from "./args.ts";
import { findGitRoot, findProjectRoot, loadConfig } from "./config.ts";
import { resolveDevServerBin, startDevServer } from "./devServer.ts";
import { cancelRun, findRun, sendEvent } from "./devServerApi.ts";
import type {
  SessionConclusion,
  SessionEvent,
  SessionStage,
} from "./events.ts";
import { freePorts } from "./ports.ts";
import {
  type GroupProcess,
  logTail,
  reapStaleGroups,
  stopGroup,
} from "./process.ts";
import { isTerminal } from "./render/model.ts";
import { type ReporterServer, startReporterServer } from "./reporterServer.ts";
import { SetupError } from "./setupError.ts";
import {
  buildJobEvent,
  buildPipelineEvent,
  describeRepo,
  type LocalRepo,
  pickTrigger,
  resolveTarget,
  type Target,
} from "./target.ts";

/** How long a cancelled run gets to destroy its Sandboxes. */
const cancelGraceMs = 10_000;

/** How long a sent event gets to start the target's run. */
const startTimeoutMs = 15_000;

/** The longest a run is watched, so nothing waits for ever. */
const runTimeoutMs = 60 * 60_000;

/** How long a finished run gets for its Sandboxes to be destroyed. */
const cleanupGraceMs = 60_000;

/** How often the Dev Server is asked whether the run has ended. */
const pollIntervalMs = 1000;

/** How long messages already on their way get to arrive after the run ends. */
const messageGraceMs = 500;

export interface SessionOptions {
  cwd: string;
  args: CliArgs;
  interactive: boolean;
  /** Receives everything the renderers draw. */
  emit(event: SessionEvent): void;
  /** Aborted on Ctrl-C, `q` or SIGTERM. */
  signal: AbortSignal;
}

export interface SessionResult {
  conclusion: SessionConclusion;
  /** The sent run's trace, when there is one. */
  runUrl?: string;
}

const conclusionOf = (status: LocalStatus): SessionConclusion => {
  if (status === "failed" || status === "cancelled") {
    return status;
  }

  return "passed";
};

/**
 * Wait for the run an event started to end. The app's `run` message says how
 * it went, but it comes before the run's Sandboxes are destroyed, so the run
 * is only over once the Dev Server says so. Polling the Dev Server is also the
 * only way to see ends the app can't report, like a cancel from the UI. On
 * abort, cancel the run and give it time to clean up.
 */
const watchRun = async (opts: {
  devServerUrl: string;
  eventId: string;
  functionId: string;
  reporter: ReporterServer;
  emit(event: SessionEvent): void;
  signal: AbortSignal;
  /** What to tell the user when the event starts no run. */
  noRunFix: string;
  /** The Dev Server and the app, which must stay up for the run to end. */
  processes: { name: string; proc: GroupProcess }[];
}): Promise<SessionResult> => {
  const { devServerUrl, eventId, functionId, reporter, emit } = opts;
  const startedAt = Date.now();
  const watching = new AbortController();
  let runId: string | undefined;
  let runUrl: string | undefined;
  let seen = false;
  let reportedStatus: LocalStatus | undefined;
  let finish: (status: LocalStatus) => void = () => {};
  let fail: (error: SetupError) => void = () => {};

  const ended = new Promise<LocalStatus>((resolve) => {
    finish = resolve;
  });

  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });

  // Only the race below handles it.
  failed.catch(() => {
    return undefined;
  });

  // Resolves early, rather than rejecting, once watching is over.
  const pause = async (ms: number): Promise<void> => {
    await sleep(ms, undefined, { signal: watching.signal }).catch(() => {
      return undefined;
    });
  };

  // The event can start other pipelines too, like `docs` beside `pr`. Only
  // the target's run is shown.
  reporter.onMessage((message: LocalMessage) => {
    if (message.kind === "manifest") {
      return;
    }

    if (message.kind === "run" && message.pipelineId === functionId) {
      seen = true;
      runId = message.runId;
      runUrl = message.url;

      if (isTerminal(message.status)) {
        reportedStatus = message.status;
      }
    }

    if (message.runId === runId) {
      emit(message);
    }
  });

  // The list, not `GET /v2/runs/{id}`: that answers COMPLETED while the run
  // is still going.
  const fetchRun = async () => {
    return findRun(devServerUrl, eventId, functionId);
  };

  const poll = async () => {
    let reportedAt: number | undefined;

    while (!watching.signal.aborted) {
      await pause(pollIntervalMs);

      const dead = opts.processes.find(({ proc }) => {
        return proc.hasExited();
      });

      if (dead) {
        fail(
          new SetupError(`The ${dead.name} exited during the run.`, {
            logTail: await logTail(dead.proc.logPath),
          }),
        );

        return;
      }

      if (Date.now() - startedAt > runTimeoutMs) {
        fail(new SetupError("The run hasn't ended after 1 hour."));

        return;
      }

      const run = await fetchRun().catch(() => {
        return undefined;
      });

      if (!run && !seen && Date.now() - startedAt > startTimeoutMs) {
        fail(
          new SetupError(
            `Sending the event started no run of "${functionId}".`,
            { fix: opts.noRunFix },
          ),
        );

        return;
      }

      runId = run?.id ?? runId;

      // A pipeline with `check: false` sends no messages, so the run is only
      // ever seen here.
      if (run && !seen) {
        seen = true;
        runUrl = devServerRunUrl(devServerUrl, run.id);

        emit({
          kind: "run",
          runId: run.id,
          pipelineId: functionId,
          status: "running",
          url: runUrl,
          at: Date.now(),
        });
      }

      if (reportedStatus) {
        reportedAt ??= Date.now();
      }

      if (run?.terminal) {
        await pause(messageGraceMs);

        if (!reportedStatus) {
          emit({
            kind: "run",
            runId: run.id,
            pipelineId: functionId,
            status: run.terminal,
            url: runUrl ?? devServerRunUrl(devServerUrl, run.id),
            at: Date.now(),
          });
        }

        finish(reportedStatus ?? run.terminal);

        return;
      }

      // Don't wait for ever on a cleanup that isn't coming.
      if (
        reportedStatus &&
        reportedAt &&
        Date.now() - reportedAt > cleanupGraceMs
      ) {
        finish(reportedStatus);

        return;
      }
    }
  };

  const aborted = new Promise<"aborted">((resolve) => {
    if (opts.signal.aborted) {
      resolve("aborted");
    }

    opts.signal.addEventListener("abort", () => {
      resolve("aborted");
    });
  });

  void poll();

  try {
    if ((await Promise.race([ended, aborted, failed])) === "aborted") {
      const id = runId ?? (await fetchRun().catch(() => undefined))?.id;

      if (id) {
        await cancelRun(devServerUrl, id).catch(() => undefined);

        await Promise.race([ended, pause(cancelGraceMs)]);
      }

      return { conclusion: "cancelled", runUrl };
    }

    return {
      conclusion: conclusionOf(await Promise.race([ended, failed])),
      runUrl,
    };
  } finally {
    watching.abort();
  }
};

/** Why a sent event might start no run, for the target. */
const noRunFix = (
  target: Target,
  trigger: string | undefined,
  repo: LocalRepo,
): string => {
  const sent = `The local event is for ${repo.ref} @ ${repo.sha}.`;

  if (target.kind !== "pipeline") {
    return `${sent} Check the Dev Server's log in the logs folder.`;
  }

  const condition = target.triggers.find((candidate) => {
    return "event" in candidate && candidate.event === trigger;
  });

  return [
    "The trigger's filter probably didn't match the local event.",
    sent,
    ...(condition && "if" in condition && condition.if
      ? [`Filter: ${condition.if}`]
      : []),
  ].join("\n");
};

const execute = async (
  opts: SessionOptions,
  onCleanup: (cleanup: () => Promise<void>) => void,
): Promise<SessionResult> => {
  const { args, emit } = opts;

  const stage = (
    name: SessionStage,
    status: "running" | "done" | "failed",
    detail?: string,
  ) => {
    emit({ kind: "stage", stage: name, status, detail, at: Date.now() });
  };

  stage("config", "running");

  const root = await findProjectRoot(opts.cwd);
  const config = await loadConfig(root);
  const bin = resolveDevServerBin(config);

  mkdirSync(config.dir, { recursive: true });
  await reapStaleGroups(join(config.dir, "pids.json"));

  stage("config", "done", config.start);

  const reporter = await startReporterServer();

  onCleanup(() => {
    return reporter.close();
  });

  const [
    main,
    connectGateway,
    connectGatewayGrpc,
    connectExecutorGrpc,
    debugApi,
    appPort,
  ] = (await freePorts(6)) as [number, number, number, number, number, number];

  const stopping = (proc: GroupProcess) => {
    return () => {
      return stopGroup(proc);
    };
  };

  stage("dev-server", "running");

  const devServer = await startDevServer({
    config,
    bin,
    appPort,
    ports: {
      main,
      connectGateway,
      connectGatewayGrpc,
      connectExecutorGrpc,
      debugApi,
    },
  });

  onCleanup(stopping(devServer.process));

  stage("dev-server", "done", devServer.url);
  stage("app", "running");

  const app = startApp({
    config,
    port: appPort,
    devServerUrl: devServer.url,
    reporterUrl: reporter.url,
  });

  onCleanup(stopping(app));

  stage("app", "done", `port ${appPort}`);
  stage("sync", "running");

  const manifest = await waitForSync({
    devServerUrl: devServer.url,
    app,
    manifest: reporter.manifest,
  });

  stage("sync", "done");

  const target = resolveTarget(manifest, args);
  // The app can sit below the repository root, but the run uploads the whole
  // repository.
  const repoRoot = await findGitRoot(root);
  const repo = await describeRepo(repoRoot);
  let event;
  let trigger: string | undefined;

  if (target.kind === "pipeline") {
    trigger = pickTrigger(target.triggers, {
      event: args.event,
      interactive: opts.interactive,
    });

    event = await buildPipelineEvent({
      trigger,
      data: args.data,
      cwd: repoRoot,
    });
  } else {
    event = buildJobEvent({
      target,
      repo,
      input: args.input,
      combo: args.combo,
    });
  }

  emit({
    kind: "ready",
    devServerUrl: devServer.url,
    repo: {
      fullName: repo.fullName,
      ref: repo.ref,
      sha: repo.sha,
      dirty: repo.dirty,
    },
    target: { kind: target.kind, id: target.id, trigger },
    at: Date.now(),
  });

  stage("send", "running");

  const eventId = await sendEvent(devServer.url, event);

  stage("send", "done");

  return watchRun({
    devServerUrl: devServer.url,
    eventId,
    functionId: target.kind === "pipeline" ? target.id : runJobFunctionId,
    reporter,
    emit,
    signal: opts.signal,
    noRunFix: noRunFix(target, trigger, repo),
    processes: [
      { name: "Dev Server", proc: devServer.process },
      { name: "app", proc: app },
    ],
  });
};

/**
 * Run the session. It never throws: a failure to set up is a `setup-error`
 * event and a `"setup-error"` conclusion. Always ends with a `done` event,
 * after the Dev Server and the app are stopped.
 */
export const runSession = async (
  opts: SessionOptions,
): Promise<SessionResult> => {
  const cleanups: (() => Promise<void>)[] = [];
  let result: SessionResult;

  try {
    result = await execute(opts, (cleanup) => {
      cleanups.push(cleanup);
    });
  } catch (error) {
    const details = error instanceof SetupError ? error : undefined;

    opts.emit({
      kind: "setup-error",
      message: errorMessage(error),
      fix: details?.fix,
      logTail: details?.logTail,
      at: Date.now(),
    });

    result = { conclusion: "setup-error" };
  }

  opts.emit({
    kind: "stage",
    stage: "cleanup",
    status: "running",
    at: Date.now(),
  });

  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }

  opts.emit({
    kind: "stage",
    stage: "cleanup",
    status: "done",
    at: Date.now(),
  });

  opts.emit({ kind: "done", ...result, at: Date.now() });

  return result;
};
