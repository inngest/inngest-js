/**
 * The images every job starts from, and the commands they hand down. `base`
 * has the repository's dependencies and the latest Dev Server, and returns the
 * integration test commands that run against it. `build` adds the built
 * `inngest` and `test` packages, `source` moves them to the commit being
 * tested, and `pack` adds the `inngest` tarball and returns the commands that
 * check it. `base` and `build` are cached, and pushes to main keep them warm
 * for pull requests.
 *
 * @module
 */

import { $, checkout, files, github } from "@inngest/ci";

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

export const base = ci.job(
  {
    id: "base",
    cache: {
      key: {
        /** The dependencies, and the code of this image. */
        deps: files("pnpm-lock.yaml", "package.json", "ci/jobs/base.ts"),
        /** The latest Dev Server release, so a new one rebuilds the image. */
        devServer: latestDevServer,
      },
      refresh: warm,
    },
  },
  async ({ key }) => {
    await checkout();

    // The sandbox image has no IPv4 localhost entry (reported to the platform team).
    await $.sh`grep -q "127.0.0.1 localhost" /etc/hosts || echo "127.0.0.1 localhost" >> /etc/hosts`.as(
      "resolve localhost",
    );

    await $.sh`npm install -g --prefix /usr/local "$(node -p "require('./package.json').packageManager.split('+')[0]")"`.as(
      "install pnpm",
    );

    await $`pnpm install --frozen-lockfile`;

    const devServer = (
      await $`npx --yes --ignore-scripts=false inngest-cli@${key.devServer} --version`
        .as("download the Dev Server")
        .text()
    ).replace(/^inngest version |-\w+$/g, "");

    const env = { INNGEST_CLI_VERSION: devServer };

    return {
      /** The integration tests of `PACKAGE` (default `inngest`), in the shard `SHARD` if set. */
      integration:
        $.sh`pnpm --filter "\${PACKAGE:-inngest}" run test:integration \${SHARD:+--shard="$SHARD"}`.env(
          env,
        ),
      /** The integration test of the example `EXAMPLE`, with streaming forced when `INNGEST_STREAMING` is `force`. */
      itest: $.sh`pnpm --filter inngest run itest "$EXAMPLE"`.env(env),
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

export const source = ci.job({ id: "source", from: build }, async () => {
  await checkout();
});

export const pack = ci.job({ id: "pack", from: source }, async () => {
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
});
