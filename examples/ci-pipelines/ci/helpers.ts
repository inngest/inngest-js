import { $, checkout } from "inngest/ci";

/**
 * Helpers are plain functions. They run on the machine of whichever job calls
 * them, so they're shared the same way any other code is.
 */
export async function install() {
  await checkout();

  // The default machine image has Node, but no corepack, npm, or pnpm, so
  // fetch pnpm's standalone build.
  await $.sh`command -v pnpm >/dev/null || (curl -fsSL -o /usr/local/bin/pnpm ${pnpmUrl} && chmod +x /usr/local/bin/pnpm)`.as(
    "install pnpm",
  );

  // The app sits inside this repository's pnpm workspace without being part
  // of it, and has no lockfile of its own.
  await $`pnpm install --ignore-workspace`.cwd(appDir);
}

const pnpmUrl =
  "https://github.com/pnpm/pnpm/releases/download/v10.17.1/pnpm-linux-x64";

/**
 * The app in this example lives in a subdirectory, so commands run there.
 */
export const appDir = "/work/examples/ci-pipelines/app";
