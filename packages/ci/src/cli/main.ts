/**
 * The `inngest-ci` bin: parses the command line, picks a renderer, runs one
 * session, publishes its state file and exits with its code. tsdown adds the shebang when it bundles
 * this file.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";

import { type CliArgs, parseCliArgs, usage } from "./args.ts";
import type { Renderer } from "./events.ts";
import {
  createInteractiveRenderer,
  createPlainRenderer,
} from "./render/index.ts";
import {
  createStateFileRenderer,
  describeStarter,
  sessionFile,
} from "./render/stateFile.ts";
import { runSession } from "./session.ts";
import { pruneSessions, resolveStateDir } from "./stateDir.ts";
import type { SetupError } from "./setupError.ts";

const exitCodes = {
  passed: 0,
  failed: 1,
  cancelled: 1,
  "setup-error": 2,
};

const createRenderer = (interactive: boolean, onQuit: () => void): Renderer => {
  if (!interactive) {
    return createPlainRenderer();
  }

  const renderer = createInteractiveRenderer();

  renderer.onQuit(onQuit);

  return renderer;
};

const main = async (): Promise<number> => {
  let args: CliArgs;

  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    const { message, fix } = error as SetupError;

    console.error(`inngest-ci: ${message}\n\n${fix ?? ""}`);

    return exitCodes["setup-error"];
  }

  if (args.help) {
    console.log(usage);

    return 0;
  }

  if (!args.name && !args.pipeline && !args.job) {
    console.error(usage);

    return exitCodes["setup-error"];
  }

  const interactive = Boolean(process.stdout.isTTY) && !args.noInteractive;
  const abort = new AbortController();

  const stop = () => {
    abort.abort();
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const renderer = createRenderer(interactive, stop);
  const stateDir = resolveStateDir({
    env: process.env,
    platform: process.platform,
    home: homedir(),
  });
  const sessionId = randomBytes(12).toString("hex");

  pruneSessions({ dir: stateDir, now: Date.now() });

  const stateFile = createStateFileRenderer({
    file: sessionFile(stateDir, sessionId),
    sessionId,
    pid: process.pid,
    startedBy: describeStarter(process.env),
    cwd: process.cwd(),
  });

  const { conclusion } = await runSession({
    cwd: process.cwd(),
    args,
    interactive,
    emit: (event) => {
      renderer.handle(event);
      stateFile.handle(event);
    },
    signal: abort.signal,
  });

  await renderer.close();
  await stateFile.close();

  return exitCodes[conclusion];
};

process.exitCode = await main();
