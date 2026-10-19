/**
 * The images every job starts from. `base` has the repository's dependencies
 * and the latest Dev Server, `build` adds the built `inngest` and `test`
 * packages, `source` moves them to the commit being tested, and `pack` adds
 * the `inngest` tarball. `base` and `build` are cached, and pushes to main
 * keep them warm for pull requests.
 *
 * @module
 */

import { $, checkout, files, github } from "@inngest/ci";
import { step } from "inngest";

import { ci } from "../client.ts";

const warm = github.push({ branches: ["main"] });

const latestDevServer = async (): Promise<string> => {
  const response = await fetch(
    "https://api.github.com/repos/inngest/inngest/releases/latest",
  );

  if (!response.ok) {
    throw new Error(
      `Finding the Dev Server release failed: ${response.status}`,
    );
  }

  const { tag_name } = (await response.json()) as { tag_name: string };

  return tag_name.replace(/^v/, "");
};

export const devServerEnv = async (): Promise<Record<string, string>> => {
  return {
    INNGEST_CLI_VERSION: await step.run(
      "find the Dev Server release",
      latestDevServer,
    ),
  };
};

export const base = ci.job(
  {
    id: "base",
    cache: {
      key: [
        files("pnpm-lock.yaml", "package.json", "ci/jobs/base.ts"),
        latestDevServer,
      ],
      refresh: warm,
    },
  },
  async () => {
    const { INNGEST_CLI_VERSION } = await devServerEnv();

    await checkout();

    await $.sh`npm install -g --prefix /usr/local "$(node -p "require('./package.json').packageManager.split('+')[0]")"`.as(
      "install pnpm",
    );

    await $`pnpm install --frozen-lockfile`;

    await $`npx --yes --ignore-scripts=false inngest-cli@${INNGEST_CLI_VERSION} --help`.as(
      "download the Dev Server",
    );
  },
);

export const build = ci.job(
  {
    id: "build",
    from: base,
    cache: {
      key: files("packages/inngest/**", "packages/test/**"),
      refresh: warm,
    },
  },
  async () => {
    await checkout();

    await $`pnpm --filter @inngest/test run build`;

    await $`pnpm --filter inngest run build`;
  },
);

export const source = ci.job({ id: "source", from: build }, async () => {
  await checkout();
});

export const pack = ci.job({ id: "pack", from: source }, async () => {
  await $.sh`mv $(npm pack ./dist --pack-destination . --silent) inngest.tgz`.cwd(
    "/work/packages/inngest",
  );
});
