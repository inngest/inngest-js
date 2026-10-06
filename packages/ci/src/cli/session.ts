/**
 * One `inngest-ci` session, start to finish: set up the Dev Server and the
 * app, choose what to run, send the events, watch the runs through the app's
 * messages, and clean up. It only talks to the outside through
 * `SessionEvent`s and, for a person at a terminal, a `Prompter`.
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
import {
  devServerRunUrl,
  errorMessage,
  sandboxAccessProblem,
} from "../util.ts";
import { startApp, waitForSync } from "./app.ts";
import type { CliArgs } from "./args.ts";
import { findGitRoot, findProjectRoot } from "./config.ts";
import {
  devServerDir,
  resolveDevServerBin,
  startDevServer,
} from "./devServer.ts";
import {
  cancelRun,
  findRun,
  runFailureReason,
  sandboxAccessProblemOf,
  sendEvent,
} from "./devServerApi.ts";
import type {
  SessionConclusion,
  SessionEvent,
  SessionStage,
} from "./events.ts";
import {
  checkFixtureName,
  loadFixture,
  loadFixtures,
  saveFixture,
} from "./fixtureStore.ts";
import { flagInput, type RunInput, resolveInput } from "./input.ts";
import { freePorts } from "./ports.ts";
import {
  type GroupProcess,
  logTail,
  reapStaleGroups,
  stopGroup,
} from "./process.ts";
import { type Pick, PromptCancelled, type Prompter } from "./prompter.ts";
import { isTerminal } from "./render/model.ts";
import { type ReporterServer, startReporterServer } from "./reporterServer.ts";
import { combineConclusions, createRouter, type SentRun } from "./runs.ts";
import { configure, confirm } from "./setup/guided.ts";
import { sandboxAccessError } from "./sandboxAccess.ts";
import { SetupError } from "./setupError.ts";
import {
  buildJobEvent,
  buildPipelineEvent,
  describeCombos,
  describeRepo,
  type LocalEvent,
  type LocalRepo,
  listTargets,
  resolveTarget,
  type Target,
  targetsOf,
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
  /** Names this session's state file and Dev Server directory. */
  sessionId: string;
  args: CliArgs;
  /** Asks the person questions. Without one, only the command line decides. */
  prompter?: Prompter;
  /** Receives everything the renderers draw. */
  emit(event: SessionEvent): void;
  /** Aborted on Ctrl-C, `q` or SIGTERM. */
  signal: AbortSignal;
}

export interface SessionResult {
  conclusion: SessionConclusion;
}

/** What the session needs to know about each event it sent. */
interface Sent extends SentRun {
  /** What the view calls the run: the pipeline, or the job. */
  label: string;
  /** What to tell the user when the event starts no run. */
  noRunFix: string;
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
  run: Sent;
  /** Registers the listener for this run's messages. */
  onMessage(listener: (message: LocalMessage) => void): void;
  /** Called once, when the run is first seen. */
  onStart(): void;
  emit(event: SessionEvent): void;
  signal: AbortSignal;
  /** The Dev Server and the app, which must stay up for the run to end. */
  processes: { name: string; proc: GroupProcess }[];
}): Promise<SessionConclusion> => {
  const { devServerUrl, emit } = opts;
  const { eventId, functionId, label } = opts.run;
  const startedAt = Date.now();
  const watching = new AbortController();
  let runId: string | undefined;
  let runUrl: string | undefined;
  let seen = false;
  let reportedStatus: LocalStatus | undefined;
  let reportedReason: string | undefined;
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

  const markSeen = () => {
    if (!seen) {
      seen = true;

      opts.onStart();
    }
  };

  opts.onMessage((message: LocalMessage) => {
    if (message.kind === "run") {
      markSeen();

      runId = message.runId;
      runUrl = message.url;

      if (isTerminal(message.status)) {
        reportedStatus = message.status;
        reportedReason = message.reason;
      }

      emit({ ...message, pipelineId: label });

      return;
    }

    emit(message);
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
          new SetupError(`Sending the event started no run of "${label}".`, {
            fix: opts.run.noRunFix,
          }),
        );

        return;
      }

      runId = run?.id ?? runId;

      // A pipeline with `check: false` sends no messages, so the run is only
      // ever seen here.
      if (run && !seen) {
        markSeen();

        runUrl = devServerRunUrl(devServerUrl, run.id);

        emit({
          kind: "run",
          runId: run.id,
          eventId,
          pipelineId: label,
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

        // A run that failed outside every job and check, like a step that
        // threw a `NonRetriableError`, never says why. Its output does.
        const failed = (reportedStatus ?? run.terminal) === "failed";
        const reason =
          failed && !reportedReason
            ? await runFailureReason(devServerUrl, run.id)
            : undefined;

        if (!reportedStatus || reason) {
          emit({
            kind: "run",
            runId: run.id,
            eventId,
            pipelineId: label,
            status: reportedStatus ?? run.terminal,
            ...(reason ? { reason } : {}),
            url: runUrl ?? devServerRunUrl(devServerUrl, run.id),
            at: Date.now(),
          });
        }

        const access = sandboxAccessProblem(reportedReason ?? reason);

        if (failed && access) {
          fail(sandboxAccessError(access));

          return;
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

      return "cancelled";
    }

    return conclusionOf(await Promise.race([ended, failed]));
  } finally {
    watching.abort();
  }
};

/**
 * Watch every sent run at once, and say how they went together. A failure to
 * watch one waits for the others to notice too, then is thrown.
 */
const watchRuns = async (opts: {
  devServerUrl: string;
  sent: Sent[];
  reporter: ReporterServer;
  onStart(): void;
  emit(event: SessionEvent): void;
  signal: AbortSignal;
  processes: { name: string; proc: GroupProcess }[];
}): Promise<SessionConclusion> => {
  const route = createRouter(opts.sent);
  const listeners = new Map<Sent, (message: LocalMessage) => void>();

  // The event can start other pipelines too, like `docs` beside `pr`. Only
  // the sent runs are shown.
  const stopListening = opts.reporter.onMessage((message) => {
    const run = route(message);

    if (run) {
      listeners.get(run)?.(message);
    }
  });

  try {
    const results = await Promise.allSettled(
      opts.sent.map((run) => {
        return watchRun({
          ...opts,
          run,
          onMessage: (listener) => {
            listeners.set(run, listener);
          },
        });
      }),
    );
    const rejected = results.find((result) => {
      return result.status === "rejected";
    });

    if (rejected) {
      throw rejected.reason;
    }

    return combineConclusions(
      results.map((result) => {
        return (result as PromiseFulfilledResult<SessionConclusion>).value;
      }),
    );
  } finally {
    stopListening();
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

const emitStage = (
  emit: (event: SessionEvent) => void,
  name: SessionStage,
  status: "running" | "done" | "failed",
  detail?: string,
): void => {
  emit({ kind: "stage", stage: name, status, detail, at: Date.now() });
};

/** What the first part of a session leaves running for the rest. */
interface Booted {
  dir: string;
  devServerUrl: string;
  processes: { name: string; proc: GroupProcess }[];
  reporter: ReporterServer;
  manifest: Awaited<ReturnType<typeof waitForSync>>;
  repoRoot: string;
  repo: LocalRepo;
}

/**
 * Resolve the config, start the Dev Server and the app, wait for the sync and
 * the manifest, and read the repository. Everything it starts is stopped by
 * `onCleanup`. `again` runs guided setup even if the config loads.
 */
const boot = async (
  opts: SessionOptions,
  onCleanup: (cleanup: () => Promise<void>) => void,
  again: boolean,
): Promise<Booted> => {
  const { emit } = opts;
  const stage = (
    name: SessionStage,
    status: "running" | "done" | "failed",
    detail?: string,
  ) => {
    emitStage(emit, name, status, detail);
  };

  const root = await findProjectRoot(opts.cwd);

  // The app can sit below the repository root, but the run uploads the whole
  // repository.
  const repoRoot = await findGitRoot(root);

  const config = await configure({
    root,
    gitRoot: repoRoot,
    prompter: opts.prompter,
    again,
  });

  stage("config", "running");

  emit({ kind: "project", root, at: Date.now() });

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
    sqliteDir: devServerDir(config.dir, opts.sessionId),
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

  const access = await sandboxAccessProblemOf(devServer.url);

  if (access) {
    throw sandboxAccessError(access);
  }

  stage("app", "running");

  const app = startApp({
    config,
    gitRoot: repoRoot,
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

  const repo = await describeRepo(repoRoot);

  emit({
    kind: "ready",
    devServerUrl: devServer.url,
    devServerDir: devServer.dir,
    repo: {
      fullName: repo.fullName,
      ref: repo.ref,
      sha: repo.sha,
      dirty: repo.dirty,
    },
    at: Date.now(),
  });

  return {
    dir: config.dir,
    devServerUrl: devServer.url,
    processes: [
      { name: "Dev Server", proc: devServer.process },
      { name: "app", proc: app },
    ],
    reporter,
    manifest,
    repoRoot,
    repo,
  };
};

/** One thing to run, with everything its event needs. */
interface Plan {
  target: Target;
  input: RunInput;
  /** Whether the person typed any of the input, which makes it worth saving. */
  entered: boolean;
  event: LocalEvent;
  label: string;
}

/** Resolve a target's input and build the event that runs it. */
const planTarget = async (
  booted: Booted,
  opts: SessionOptions,
  pick: { target: Target; flags: RunInput },
): Promise<Plan> => {
  const { target, flags } = pick;
  const { args, prompter } = opts;
  const { input, entered } = await resolveInput({
    target,
    flags,
    fixture: args.fixture
      ? loadFixture(booted.dir, target.id, args.fixture)
      : undefined,
    saved: prompter ? loadFixtures(booted.dir, target.id) : {},
    ask: prompter,
  });

  if (target.kind === "pipeline") {
    return {
      target,
      input,
      entered,
      event: await buildPipelineEvent({
        trigger: input.trigger as string,
        data: input.data,
        cwd: booted.repoRoot,
      }),
      label: target.id,
    };
  }

  return {
    target,
    input,
    entered,
    event: buildJobEvent({
      target,
      repo: booted.repo,
      input: input.input,
      combos: input.combos,
    }),
    label: input.combos
      ? `${target.id} (${describeCombos(input.combos)})`
      : target.id,
  };
};

/**
 * Ask whether to keep what was typed for each plan. Backing out of the
 * question only skips it.
 */
const offerFixtures = async (
  booted: Booted,
  prompter: Prompter,
  plans: Plan[],
): Promise<void> => {
  for (const plan of plans.filter((candidate) => {
    return candidate.entered;
  })) {
    const name = await prompter
      .line(
        `Save the data for ${plan.target.id} as a fixture? Name`,
        (text) => {
          return text === "" ? undefined : checkFixtureName(text);
        },
      )
      .catch(() => {
        return "";
      });

    if (name) {
      saveFixture({
        dir: booted.dir,
        targetId: plan.target.id,
        name,
        input: plan.input,
        now: Date.now(),
      });
    }
  }
};

/** Choose what to run, send it, and watch it end. */
const runRound = async (
  booted: Booted,
  opts: SessionOptions,
): Promise<SessionResult> => {
  const { args, emit, prompter } = opts;
  const { devServerUrl, repo } = booted;
  const named = Boolean(args.name || args.pipeline || args.job);

  // `execute` makes sure there's a prompter when nothing is named.
  const picks: Pick[] = named
    ? [{ target: resolveTarget(booted.manifest, args) }]
    : await (prompter as Prompter).pick(targetsOf(booted.manifest));
  const plans: Plan[] = [];

  for (const { target, combos } of picks) {
    plans.push(
      await planTarget(booted, opts, {
        target,
        flags: named ? flagInput(args, target) : { combos },
      }),
    );
  }

  emit({
    kind: "targets",
    targets: plans.map(({ target, input }) => {
      return { kind: target.kind, id: target.id, trigger: input.trigger };
    }),
    at: Date.now(),
  });

  emitStage(emit, "send", "running");

  const eventIds = await Promise.all(
    plans.map(({ event }) => {
      return sendEvent(devServerUrl, event);
    }),
  );

  emitStage(emit, "send", "done");

  const sent = plans.map((plan, index): Sent => {
    return {
      eventId: eventIds[index] as string,
      functionId:
        plan.target.kind === "pipeline" ? plan.target.id : runJobFunctionId,
      label: plan.label,
      noRunFix: noRunFix(plan.target, plan.input.trigger, repo),
    };
  });
  let started = 0;

  emitStage(
    emit,
    "start",
    "running",
    `${sent.map((run) => run.label).join(", ")} to start…`,
  );

  let conclusion: SessionConclusion;

  try {
    conclusion = await watchRuns({
      devServerUrl,
      sent,
      reporter: booted.reporter,
      onStart: () => {
        started += 1;

        if (started === sent.length) {
          emitStage(emit, "start", "done");
        }
      },
      emit,
      signal: opts.signal,
      processes: booted.processes,
    });
  } catch (error) {
    if (started < sent.length) {
      emitStage(emit, "start", "failed");
    }

    throw error;
  }

  emit({ kind: "done", conclusion, at: Date.now() });

  if (prompter && !opts.signal.aborted) {
    await offerFixtures(booted, prompter, plans);
  }

  return { conclusion };
};

const execute = async (
  opts: SessionOptions,
  onCleanup: (cleanup: () => Promise<void>) => void,
  again: boolean,
): Promise<SessionResult> => {
  const { args, emit, prompter } = opts;
  const named = Boolean(args.name || args.pipeline || args.job);
  const booted = await boot(opts, onCleanup, again);

  if (!named && !prompter) {
    const [first] = targetsOf(booted.manifest);

    throw new SetupError("No pipeline or job to run was given.", {
      fix: `${listTargets(booted.manifest)}\n\nRun one, like: inngest-ci ${first?.id ?? "<name>"}`,
    });
  }

  if (args.fixture && !named) {
    throw new SetupError("--fixture needs a pipeline or job to use it with.");
  }

  let result: SessionResult | undefined;

  try {
    do {
      result = await runRound(booted, opts);
    } while (
      prompter &&
      !opts.signal.aborted &&
      (await prompter.linger(!named))
    );
  } catch (error) {
    // Backing out of a question ends the session, with the last runs' result.
    if (!(error instanceof PromptCancelled)) {
      throw error;
    }
  }

  if (!result) {
    result = { conclusion: "cancelled" };

    emit({ kind: "done", ...result, at: Date.now() });
  }

  return result;
};

/** What one attempt at a session ended with. */
interface Attempt extends SessionResult {
  /** Whether running guided setup again could fix what stopped it. */
  reconfigurable: boolean;
}

/**
 * One attempt: a failure to set up is a `setup-error` event and a
 * `"setup-error"` conclusion, and backing out of setup is a cancel. Every
 * attempt ends with a `done` event, and the Dev Server and the app are
 * stopped before it returns.
 */
const attempt = async (
  opts: SessionOptions,
  again: boolean,
): Promise<Attempt> => {
  const cleanups: (() => Promise<void>)[] = [];
  let result: Attempt;

  try {
    result = {
      ...(await execute(
        opts,
        (cleanup) => {
          cleanups.push(cleanup);
        },
        again,
      )),
      reconfigurable: false,
    };
  } catch (error) {
    const details = error instanceof SetupError ? error : undefined;

    if (error instanceof PromptCancelled) {
      result = { conclusion: "cancelled", reconfigurable: false };
    } else {
      opts.emit({
        kind: "setup-error",
        message: errorMessage(error),
        fix: details?.fix,
        logTail: details?.logTail,
        at: Date.now(),
      });

      result = {
        conclusion: "setup-error",
        reconfigurable: details?.reconfigurable ?? false,
      };
    }

    opts.emit({ kind: "done", conclusion: result.conclusion, at: Date.now() });
  }

  emitStage(opts.emit, "cleanup", "running");

  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }

  emitStage(opts.emit, "cleanup", "done");

  return result;
};

/**
 * Run the session. It never throws. When the config turns out to be wrong and
 * a person is at a terminal, it offers to run guided setup again and, if they
 * say yes, starts over.
 */
export const runSession = async (
  opts: SessionOptions,
): Promise<SessionResult> => {
  const { prompter } = opts;
  let again = false;

  while (true) {
    const { reconfigurable, ...result } = await attempt(opts, again);

    if (
      !(reconfigurable && prompter) ||
      opts.signal.aborted ||
      !(await confirm(prompter, "Run setup again?").catch(() => {
        return false;
      }))
    ) {
      return result;
    }

    opts.emit({ kind: "restart", at: Date.now() });

    again = true;
  }
};
