/**
 * One `inngest-ci` run: resolve the config, boot an isolated Dev Server and the
 * app, choose what to run, send its event, show the run until it ends, and
 * clean up. Prompts fill in what the flags leave out when a person is at a
 * terminal. A failure the user must fix is a `SetupError`.
 *
 * @module
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  intro,
  log,
  multiselect,
  note,
  outro,
  select,
  text,
  isCancel,
} from "@clack/prompts";

import type { LocalMessage, LocalStatus } from "../local/protocol.ts";
import { runJobFunctionId } from "../local/protocol.ts";
import { errorMessage } from "../util.ts";
import { startApp, waitForSync } from "./app.ts";
import { loadConfig, NoConfigError } from "./config.ts";
import {
  cancelRun,
  listRuns,
  runFailureReason,
  sandboxAccessProblemOf,
  sendEvent,
  startDevServer,
} from "./devServer.ts";
import { createLiveView } from "./live.ts";
import type { ManagedProcess } from "./processes.ts";
import { freePorts, logTail } from "./processes.ts";
import { startReporterServer } from "./reporterServer.ts";
import { sandboxAccessError, sandboxAccessProblem } from "./sandboxAccess.ts";
import { Cancelled, guidedSetup } from "./setup.ts";
import { SetupError } from "./setupError.ts";
import { cancelStrays } from "./strays.ts";
import type { Combo, LocalEvent, Target } from "./target.ts";
import {
  buildJobEvent,
  buildPipelineEvent,
  describeCombo,
  matchTrigger,
  resolveTarget,
  selectCombos,
  targetsOf,
} from "./target.ts";

const pollMs = 500;
const messageGraceMs = 500;
const startTimeoutMs = 60_000;
const runTimeoutMs = 60 * 60_000;

/** How long a finished run may wait for the Dev Server to call it ended. */
const cleanupGraceMs = 60_000;

/** How long a cancelled run's cleanup may take before the CLI stops waiting. */
const strayGraceMs = 60_000;

export interface RunOptions {
  cwd: string;

  /** The pipeline, job or matrix to run. Asked for when left out. */
  target?: string;

  /** The trigger to run a pipeline with, like `pull_request.opened`. */
  event?: string;

  /** JSON: the `data` of a manual or comment trigger. */
  data?: string;

  /** JSON: the input of a job. */
  input?: string;

  /** Matrix axis values from `--<axis> <value>` flags. */
  axes: Record<string, string[]>;

  /** Whether prompts may be shown. */
  interactive: boolean;
}

export type Conclusion = "passed" | "failed" | "cancelled";

/** An answer that is a cancelled prompt ends the run. */
const answer = <T>(value: T): Exclude<T, symbol> => {
  if (isCancel(value)) {
    throw new Cancelled();
  }

  return value as Exclude<T, symbol>;
};

const parseJson = (flag: string, source: string): unknown => {
  try {
    return JSON.parse(source);
  } catch {
    throw new SetupError(`--${flag} is not valid JSON.`);
  }
};

/** JSON from the flag, else from a prompt, else `fallback`. */
const jsonInput = async (opts: {
  flag: string;
  given?: string;
  message: string;
  ask: boolean;
  fallback?: unknown;
}): Promise<unknown> => {
  if (opts.given !== undefined) {
    return parseJson(opts.flag, opts.given);
  }

  if (!opts.ask) {
    return opts.fallback;
  }

  const source = answer(
    await text({
      message: opts.message,
      initialValue: "{}",
      validate: (value) => {
        try {
          JSON.parse(value ?? "");

          return undefined;
        } catch {
          return "Must be JSON";
        }
      },
    }),
  );

  return JSON.parse(source);
};

/** The target, the trigger and the data it needs, asked for when not given. */
const chooseEvent = async (
  opts: RunOptions,
  targets: Target[],
): Promise<{ target: Target; event: LocalEvent }> => {
  let name = opts.target;

  if (!name) {
    if (!opts.interactive) {
      throw new SetupError("Name a pipeline, job or matrix to run.", {
        fix: targets
          .map((target) => {
            return `${target.kind} ${target.id}`;
          })
          .join("\n"),
      });
    }

    name = answer(
      await select({
        message: "What do you want to run?",
        options: targets.map((target) => {
          return { value: target.id, label: target.id, hint: target.kind };
        }),
      }),
    );
  }

  const target = resolveTarget(targets, name);

  if (target.kind === "pipeline") {
    return { target, event: await pipelineEvent(opts, target) };
  }

  const input = target.takesInput
    ? await jsonInput({
        flag: "input",
        given: opts.input,
        message: `Input for ${target.id} (JSON)`,
        ask: opts.interactive,
      })
    : undefined;

  const combos = await chooseCombos(opts, target);

  return {
    target,
    event: await buildJobEvent({ target, input, combos, cwd: opts.cwd }),
  };
};

const pipelineEvent = async (
  opts: RunOptions,
  target: Extract<Target, { kind: "pipeline" }>,
): Promise<LocalEvent> => {
  const { events } = target;
  let trigger = opts.event ? matchTrigger(events, opts.event) : events[0];

  if (events.length === 0) {
    throw new SetupError("Cron triggers can't be run locally yet.");
  }

  if (!opts.event && events.length > 1) {
    if (!opts.interactive) {
      throw new SetupError(`${target.id} has several triggers.`, {
        fix: `Pick one with --event. Triggers: ${events.join(", ")}`,
      });
    }

    trigger = answer(
      await select({
        message: "Which trigger?",
        options: events.map((event) => {
          return { value: event, label: event };
        }),
      }),
    );
  }

  const manual = trigger?.startsWith("ci/manual.") ?? false;

  const data = await jsonInput({
    flag: "data",
    given: opts.data,
    message: "Event data (JSON)",
    ask: opts.interactive && manual,
    fallback: {},
  });

  return buildPipelineEvent({
    pipelineId: target.id,
    trigger: trigger as string,
    data: data as Record<string, unknown>,
    cwd: opts.cwd,
  });
};

/** The matrix combinations to run: from flags, else picked, else every one. */
const chooseCombos = async (
  opts: RunOptions,
  target: Extract<Target, { kind: "job" }>,
): Promise<Combo[] | undefined> => {
  const flagged = selectCombos(target, opts.axes);

  if (flagged || !target.combos || !opts.interactive) {
    return flagged;
  }

  const picked = answer(
    await multiselect({
      message: `Combinations of ${target.id}`,
      options: target.combos.map((combo, index) => {
        return { value: index, label: describeCombo(combo) };
      }),
      initialValues: target.combos.map((_, index) => {
        return index;
      }),
    }),
  );

  return picked.length === target.combos.length
    ? undefined
    : picked.map((index) => {
        return target.combos?.[index] as Combo;
      });
};

/** What the app has said of the run being watched. */
interface Reported {
  runId?: string;

  /** Set once the app says the run ended. */
  status?: LocalStatus;
  reason?: string;
}

/**
 * Show the run the event started until the Dev Server says it ended, and say
 * how it went. Fails if the app or the Dev Server exits, or no run starts.
 */
const watchRun = async (opts: {
  devServerUrl: string;
  sent: { eventId: string; functionId: string };
  processes: { name: string; proc: ManagedProcess }[];
  live: ReturnType<typeof createLiveView>;
  signal: AbortSignal;
  reported: Reported;
}): Promise<Conclusion> => {
  const { devServerUrl, sent, live, reported } = opts;
  const startedAt = Date.now();
  let reportedAt: number | undefined;
  let seen = false;

  const markSeen = (runId: string): void => {
    if (!seen) {
      seen = true;

      live.print(() => {
        log.info(`Run: ${devServerUrl}/run?runID=${runId}`);
      });

      live.status("Finishing the run");
    }
  };

  while (!opts.signal.aborted) {
    await sleep(pollMs);

    const dead = opts.processes.find(({ proc }) => {
      return proc.hasExited();
    });

    if (dead) {
      throw new SetupError(`The ${dead.name} exited during the run.`, {
        logTail: logTail(dead.proc.logPath),
      });
    }

    if (Date.now() - startedAt > runTimeoutMs) {
      throw new SetupError("The run hasn't ended after 1 hour.");
    }

    const runs = await listRuns(devServerUrl).catch(() => {
      return [];
    });

    const run = runs.find((candidate) => {
      return (
        candidate.functionId === sent.functionId &&
        candidate.eventIds.includes(sent.eventId)
      );
    });

    if (!run && !reported.runId && Date.now() - startedAt > startTimeoutMs) {
      throw new SetupError(
        `Sending the event started no run of "${sent.functionId}".`,
        {
          fix: "Check that the app serves ci.functions() and the pipeline's trigger matches.",
        },
      );
    }

    if (run) {
      reported.runId ??= run.id;
    }

    if (reported.runId) {
      markSeen(reported.runId);
    }

    if (reported.status) {
      reportedAt ??= Date.now();
    }

    if (run?.terminal) {
      await sleep(messageGraceMs);

      const status = reported.status ?? run.terminal;
      const reason =
        reported.reason ??
        (status === "failed"
          ? await runFailureReason(devServerUrl, run.id)
          : undefined);
      const access = sandboxAccessProblem(reason);

      if (status === "failed" && access) {
        throw sandboxAccessError(access);
      }

      if (reason) {
        live.print(() => {
          log.error(reason);
        });
      }

      return conclusionOf(status);
    }

    // Don't wait for ever on a cleanup that isn't coming.
    if (
      reported.status &&
      reportedAt &&
      Date.now() - reportedAt > cleanupGraceMs
    ) {
      return conclusionOf(reported.status);
    }
  }

  return "cancelled";
};

const conclusionOf = (status: LocalStatus): Conclusion => {
  return status === "passed" || status === "cached"
    ? "passed"
    : status === "cancelled"
      ? "cancelled"
      : "failed";
};

/** Say a `SetupError`, or any other error, the way a terminal wants it. */
const showError = (error: unknown): void => {
  if (error instanceof Cancelled) {
    return;
  }

  log.error(errorMessage(error));

  if (error instanceof SetupError) {
    if (error.fix) {
      note(error.fix, "How to fix");
    }

    if (error.logTail) {
      note(error.logTail, "Log");
    }
  }
};

/** Run once and return the process exit code: 0 passed, 1 failed, 2 setup error. */
export const runOnce = async (
  opts: RunOptions,
  signal: AbortSignal,
): Promise<number> => {
  intro("inngest-ci");

  const live = createLiveView();
  const processes: { name: string; proc: ManagedProcess }[] = [];
  const reported: Reported = {};
  const eventIds: string[] = [];
  let sent: { eventId: string; functionId: string } | undefined;
  const early: LocalMessage[] = [];
  let reporter: Awaited<ReturnType<typeof startReporterServer>> | undefined;
  let tmp: string | undefined;
  let devServerUrl: string | undefined;
  let code = 0;

  const onMessage = (message: LocalMessage): void => {
    if (message.kind === "manifest") {
      return;
    }

    // Messages can beat the answer to the event that started their run.
    if (!sent) {
      early.push(message);

      return;
    }

    if (message.kind === "run") {
      if (
        message.eventId !== sent.eventId ||
        message.pipelineId !== sent.functionId
      ) {
        return;
      }

      reported.runId = message.runId;

      if (message.status !== "running" && message.status !== "queued") {
        reported.status = message.status;
        reported.reason = message.reason;
      }

      return;
    }

    if (message.runId === reported.runId) {
      live.handle(message);
    }
  };

  try {
    let config: Awaited<ReturnType<typeof loadConfig>>;

    try {
      config = await loadConfig(opts.cwd);
    } catch (error) {
      if (!(error instanceof NoConfigError) || !opts.interactive) {
        throw error;
      }

      log.warn(error.message);

      await guidedSetup(opts.cwd);

      config = await loadConfig(opts.cwd);
    }

    tmp = await mkdtemp(join(tmpdir(), "inngest-ci-"));

    reporter = await startReporterServer(onMessage);

    const [appPort] = await freePorts(1);

    live.status("Starting the Dev Server");

    const devServer = await startDevServer({
      appUrl: `http://127.0.0.1:${appPort}${config.path}`,
      cwd: config.root,
      logPath: join(tmp, "dev-server.log"),
    });

    devServerUrl = devServer.url;

    processes.push({ name: "Dev Server", proc: devServer.process });

    const access = await sandboxAccessProblemOf(devServer.url);

    if (access) {
      throw sandboxAccessError(access);
    }

    live.status("Starting your app");

    const app = startApp({
      config,
      port: appPort as number,
      devServerUrl: devServer.url,
      reporterUrl: reporter.url,
      logPath: join(tmp, "app.log"),
    });

    processes.push({ name: "app", proc: app });

    const manifest = await waitForSync({
      devServerUrl: devServer.url,
      app,
      manifest: reporter.manifest,
    });

    live.stop();

    const { target, event } = await chooseEvent(opts, targetsOf(manifest));

    live.status(`Starting ${target.id}`);

    const eventId = await sendEvent(devServer.url, event);

    eventIds.push(eventId);

    sent = {
      eventId,
      functionId: target.kind === "pipeline" ? target.id : runJobFunctionId,
    };

    for (const message of early.splice(0)) {
      onMessage(message);
    }

    const conclusion = await watchRun({
      devServerUrl: devServer.url,
      sent,
      processes,
      live,
      signal,
      reported,
    });

    live.stop();

    code = conclusion === "passed" ? 0 : 1;

    outro(`${target.id} ${conclusion}`);
  } catch (error) {
    live.stop();

    showError(error);

    code = error instanceof Cancelled ? 1 : 2;

    outro("inngest-ci stopped");
  } finally {
    if (devServerUrl && eventIds.length > 0) {
      const url = devServerUrl;

      live.status("Cancelling the run and cleaning up Sandboxes");

      await cancelStrays({
        eventIds,
        graceMs: strayGraceMs,
        pollMs,
        listRuns: () => {
          return listRuns(url);
        },
        cancel: (runId) => {
          return cancelRun(url, runId);
        },
      });

      live.stop();
    }

    for (const { proc } of processes.reverse()) {
      await proc.stop();
    }

    await reporter?.close();

    if (tmp) {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  return code;
};
