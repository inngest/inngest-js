/**
 * Opens a URL in the user's browser, which on WSL means the Windows one.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { findOnPath } from "../devServer.ts";

/** What the choice of opener depends on, so it can be tested. */
export interface OpenEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** The contents of `/proc/version`, when there is one. */
  procVersion?: string;
  onPath(name: string): boolean;
}

/** Whether this is Linux running under WSL, which has no desktop of its own. */
export const isWsl = (opts: Pick<OpenEnv, "env" | "procVersion">): boolean => {
  return (
    Boolean(opts.env.WSL_DISTRO_NAME) ||
    /microsoft/i.test(opts.procVersion ?? "")
  );
};

/**
 * The command that opens `url`, and the URL to give it. On WSL the browser is
 * Windows's, which reaches the Dev Server as `localhost`: `wslview` when it's
 * installed, else `explorer.exe`.
 */
export const openerFor = (
  url: string,
  opts: OpenEnv,
): { command: string; args: string[] } => {
  if (opts.platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (opts.platform === "win32") {
    // `start` is a `cmd` built-in that mangles `&` in URLs; this does the same job.
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }

  if (isWsl(opts)) {
    const windowsUrl = url.replace("127.0.0.1", "localhost");

    return opts.onPath("wslview")
      ? { command: "wslview", args: [windowsUrl] }
      : { command: "explorer.exe", args: [windowsUrl] };
  }

  return { command: "xdg-open", args: [url] };
};

/**
 * Open `url` with the platform's opener, detached. Resolves to whether it
 * opened, so the caller can show the URL instead when it didn't. `explorer.exe`
 * exits with 1 even when it worked, so only an opener that can't start counts
 * as failed.
 */
export const openUrl = (url: string): Promise<boolean> => {
  let procVersion: string | undefined;

  try {
    procVersion = readFileSync("/proc/version", "utf8");
  } catch {
    // Not Linux.
  }

  const { command, args } = openerFor(url, {
    platform: process.platform,
    env: process.env,
    procVersion,
    onPath: (name) => {
      return findOnPath(name, process.env, process.platform) !== undefined;
    },
  });

  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });

    child.once("error", () => {
      resolve(false);
    });

    child.once("exit", (code) => {
      resolve(code === 0 || command === "explorer.exe");
    });

    child.unref();
  });
};
