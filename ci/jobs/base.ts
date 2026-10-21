/**
 * The images every job starts from, and the commands they hand down. `base`
 * has the repository's dependencies and the latest Dev Server, and returns the
 * integration test commands that run against it. `build` adds the built
 * `inngest` and `test` packages, `pack` adds the `inngest` tarball and
 * returns the commands that check it. Every job checks out the commit being
 * tested itself. `base`, `build` and `pack` are cached, and pushes to main keep
 * them warm for pull requests.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  $,
  type Command,
  checkout,
  files,
  github,
  waitForHttp,
} from "@inngest/ci";

import { ci } from "../client.ts";

const warm = github.push({ branches: ["main"], repo: "inngest/inngest-js" });

const latestDevServer = async (): Promise<string> => {
  const response = await fetch("https://registry.npmjs.org/inngest-cli/latest");
  const { version } = (await response.json()) as { version: string };

  return version;
};

/** Where global tools are installed, which is on the `PATH`. */
const installPrefix = "/usr/local";

/** The binary that the package's postinstall downloads over its own wrapper script. */
const devServerBin = `${installPrefix}/lib/node_modules/inngest-cli/bin/inngest`;

/** The port the Dev Server listens on, which the tests expect. */
export const devServerPort = 8288;

const thisFile = new URL(import.meta.url);

/**
 * The hash of this file. The pull request's checkout has no `ci/` directory,
 * so a `files()` key on this file can't notice an edit to the image's recipe.
 */
const recipe = async (): Promise<string> => {
  const source = await readFile(thisFile);

  return createHash("sha256").update(source).digest("hex");
};

/**
 * Runs a test command from `base` against the Dev Server from `base`, which
 * is started in the background first and waited for until it answers. Tests
 * that need a Dev Server run through this, so none can start without one.
 */
export const runWithDevServer = async (
  from: { $: { devServer: Command } },
  tests: Command,
): Promise<void> => {
  await from.$.devServer.background();

  await waitForHttp(`http://localhost:${devServerPort}/dev`);

  await tests;
};

export const base = ci.job(
  {
    id: "base",
    cache: {
      key: {
        /** The dependencies. */
        deps: files("pnpm-lock.yaml", "package.json"),
        /** The code of this image, so a changed recipe rebuilds it. */
        recipe,
        /** The latest Dev Server release, so a new one rebuilds the image. */
        devServer: latestDevServer,
      },
      refresh: warm,
    },
  },
  async ({ key }) => {
    await checkout();

    await $.sh`npm install -g --prefix ${installPrefix} "$(node -p "require('./package.json').packageManager.split('+')[0]")"`.as(
      "install pnpm",
    );

    await $`pnpm install --frozen-lockfile`;

    await $`npm install -g --prefix ${installPrefix} bun`;

    await $`npm install -g --prefix ${installPrefix} --ignore-scripts=false inngest-cli@${key.devServer}`.as(
      "download the Dev Server",
    );

    await $`${devServerBin} --version`;

    return {
      /** The Dev Server on port 8288, for the tests to find already listening. */
      devServer: $`${devServerBin} dev --port ${devServerPort} --no-discovery --no-poll --retry-interval 1 --tick 10`,
      /** The integration tests of `PACKAGE` (default `inngest`), in the shard `SHARD` if set. */
      integration: $.sh`pnpm --filter "\${PACKAGE:-inngest}" run test:integration \${SHARD:+--shard="$SHARD"}`,
      /** The integration test of the example `EXAMPLE`, with streaming forced when `INNGEST_STREAMING` is `force`. */
      itest: $.sh`pnpm --filter inngest run itest "$EXAMPLE"`,
    };
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

export const pack = ci.job(
  {
    id: "pack",
    from: build,
    cache: {
      key: files("packages/inngest/**", "packages/test/**", "ci/jobs/base.ts"),
      refresh: warm,
    },
  },
  async () => {
    const dir = "/work/packages/inngest";

    await $.sh`mv $(npm pack ./dist --pack-destination . --silent) inngest.tgz`.cwd(
      dir,
    );

    return {
      /** How the tarball's publishing config looks to publint. */
      publint: $`pnpm dlx publint --pack npm ./dist`.cwd(dir),
      /** Whether the tarball's types are right for every module system. */
      attw: $`pnpm exec attw inngest.tgz`.cwd(dir),
      /** The tarball installed into a TypeScript composite project, and its tests. */
      composite: $.sh`npm i ../../inngest.tgz && npm run test`.cwd(
        `${dir}/test/composite_project`,
      ),
    };
  },
);
