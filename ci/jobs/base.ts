/**
 * The base images every job starts from, each built once and reused until its
 * key changes: `base` has the repository with dependencies installed, `build`
 * adds the built `inngest` and `test` packages, and `pack` adds the `inngest`
 * tarball. Pushes to main keep `base` and `build` warm for pull requests.
 *
 * @module
 */

import { $, checkout, files, github } from "@inngest/ci";

import { ci } from "../client.ts";

const warm = github.push({ branches: ["main"] });

export const base = ci.job(
  {
    id: "base",
    cache: {
      key: files("pnpm-lock.yaml", "package.json", "ci/jobs/base.ts"),
      refresh: warm,
    },
  },
  async () => {
    await checkout();

    await $.sh`grep -q localhost /etc/hosts || echo "127.0.0.1 localhost" >> /etc/hosts`.as(
      "resolve localhost",
    );

    await $.sh`npm install -g --prefix /usr/local "$(node -p "require('./package.json').packageManager.split('+')[0]")"`.as(
      "install pnpm",
    );

    await $`pnpm install --frozen-lockfile`;

    await $`npx --yes --ignore-scripts=false inngest-cli@latest --help`.as(
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

export const pack = ci.job({ id: "pack", from: build }, async () => {
  await checkout();

  await $.sh`mv $(npm pack ./dist --pack-destination . --silent) inngest.tgz`.cwd(
    "/work/packages/inngest",
  );
});
