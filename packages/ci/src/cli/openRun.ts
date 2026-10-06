/**
 * `inngest-ci open`: shows a run of an earlier session in the Dev Server's UI.
 * Every session keeps its runs in its own Dev Server database, so this finds
 * the session and starts a Dev Server on that database, without the app. A
 * session that's still running has its own Dev Server up, which is used
 * instead.
 *
 * @module
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { devServerRunUrl } from "../util.ts";
import { findProjectRoot, loadConfig } from "./config.ts";
import { resolveDevServerBin, startDevServer } from "./devServer.ts";
import { latestRunId, runExists } from "./devServerApi.ts";
import { freePorts } from "./ports.ts";
import { logTail, reapStaleGroups, stopGroup } from "./process.ts";
import { openUrl } from "./render/open.ts";
import { SetupError } from "./setupError.ts";
import { findSession } from "./stateDir.ts";

/** Print the run's URL and open it, saying so when no browser opens. */
const show = async (opts: {
  devServerUrl: string;
  runId?: string;
  log(line: string): void;
}): Promise<void> => {
  const { devServerUrl, log } = opts;
  const runId = opts.runId ?? (await latestRunId(devServerUrl));

  if (!runId) {
    throw new SetupError("That session has no runs to show.");
  }

  if (opts.runId && !(await runExists(devServerUrl, runId))) {
    throw new SetupError(`That session has no run "${runId}".`);
  }

  const url = devServerRunUrl(devServerUrl, runId);

  log(`Run ${runId}\n${url}`);

  if (!(await openUrl(url))) {
    log("Couldn't open a browser. Open the URL above.");
  }
};

/**
 * Show `runId`, or the latest run, in the browser and keep the Dev Server up
 * until `signal` aborts. Throws a `SetupError` when there's nothing to show.
 */
export const openRun = async (opts: {
  cwd: string;
  /** The directory from `resolveStateDir()`, where sessions are recorded. */
  stateDir: string;
  runId?: string;
  log(line: string): void;
  signal: AbortSignal;
}): Promise<void> => {
  const { log, signal } = opts;
  const root = await findProjectRoot(opts.cwd);
  const session = findSession({
    dir: opts.stateDir,
    projectRoot: root,
    runId: opts.runId,
  });

  if (!session) {
    throw new SetupError(
      opts.runId
        ? `No session of this project ran "${opts.runId}".`
        : "This project has no earlier session to show.",
      {
        fix: "Sessions are cleaned up some time after they end. Run something first, like: inngest-ci <pipeline or job>",
      },
    );
  }

  if (session.liveUrl) {
    await show({ ...opts, devServerUrl: session.liveUrl });

    return;
  }

  const config = await loadConfig(root);
  const bin = resolveDevServerBin(config);

  mkdirSync(config.dir, { recursive: true });
  await reapStaleGroups(join(config.dir, "pids.json"));

  const [
    main,
    connectGateway,
    connectGatewayGrpc,
    connectExecutorGrpc,
    debugApi,
  ] = (await freePorts(5)) as [number, number, number, number, number];
  const devServer = await startDevServer({
    config,
    bin,
    sqliteDir: session.devServerDir,
    ports: {
      main,
      connectGateway,
      connectGatewayGrpc,
      connectExecutorGrpc,
      debugApi,
    },
  });

  try {
    await show({ ...opts, devServerUrl: devServer.url });

    log("The Dev Server is up. Press Ctrl-C to stop it.");

    while (!signal.aborted && !devServer.process.hasExited()) {
      await sleep(500, undefined, { signal }).catch(() => {
        return undefined;
      });
    }

    if (!signal.aborted) {
      throw new SetupError("The Dev Server exited.", {
        logTail: await logTail(devServer.process.logPath),
      });
    }
  } finally {
    await stopGroup(devServer.process);
  }
};
