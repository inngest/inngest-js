import { $, checkout } from "inngest/ci";

/**
 * Helpers are plain functions. They run on the machine of whichever job calls
 * them, so they're shared the same way any other code is.
 */
export async function install() {
  await checkout();
  await $`corepack enable`.nothrow();
  await $`pnpm install --frozen-lockfile`.cwd("/work/examples/ci-pipelines/app");
}

/**
 * The app in this example lives in a subdirectory, so commands run there.
 */
export const appDir = "/work/examples/ci-pipelines/app";
