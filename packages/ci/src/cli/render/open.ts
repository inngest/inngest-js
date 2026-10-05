/**
 * Opens a URL in the user's browser.
 *
 * @module
 */

import { spawn } from "node:child_process";

const openers: Partial<Record<NodeJS.Platform, [string, string[]]>> = {
  darwin: ["open", []],
  // `start` is a `cmd` built-in that mangles `&` in URLs; this does the same job.
  win32: ["rundll32", ["url.dll,FileProtocolHandler"]],
};

/** Open `url` with the platform's opener, detached. A failure is ignored. */
export const openUrl = (url: string): void => {
  const [command, args] = openers[process.platform] ?? ["xdg-open", []];
  const child = spawn(command, [...args, url], {
    detached: true,
    stdio: "ignore",
  });

  child.on("error", () => {});
  child.unref();
};
