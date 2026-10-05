import { $, checkout } from "@inngest/ci";

export const appDir = "/work/examples/ci-pipelines/app";

const pnpmUrl =
  "https://github.com/pnpm/pnpm/releases/download/v10.17.1/pnpm-linux-x64";

export async function install() {
  await checkout();

  await $.sh`command -v pnpm >/dev/null || (curl -fsSL -o /usr/local/bin/pnpm ${pnpmUrl} && chmod +x /usr/local/bin/pnpm)`.as(
    "install pnpm",
  );

  await $`pnpm install --ignore-workspace`.cwd(appDir);
}
