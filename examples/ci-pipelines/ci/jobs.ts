import { step } from "inngest";
import {
  $,
  checkout,
  files,
  from,
  github,
  report,
  sandbox,
  waitForHttp,
} from "inngest/ci";

import { ci } from "./client.ts";
import { appDir, install } from "./helpers.ts";
import { deploys } from "./services.ts";

/**
 * `setup` is the job everything else starts from. It's cached on the lockfile,
 * and a nightly refresh rebuilds it so pull requests never pay for the install.
 */
export const setup = ci.job(
  {
    id: "setup",
    cache: {
      key: files("examples/ci-pipelines/app/package.json", "pnpm-lock.yaml"),
      refresh: [{ cron: "0 3 * * *" }],
    },
  },
  async () => {
    await install();
    return { installedAt: new Date().toISOString() };
  },
);

export const lint = ci.job("lint", async () => {
  await from(setup);
  await $`pnpm lint`.cwd(appDir);
});

export const test = ci.job("test", async () => {
  await from(setup);

  // One retry, because the app has a test that can be made flaky on purpose.
  const result = await $`pnpm test`.cwd(appDir).retries(1);

  await report.summary(
    `Tests finished in ${Math.round(result.durationMs / 1000)}s`,
  );

  return result.exitCode;
});

/**
 * A curried job: one job per Node version, with the ID coming from the input
 * rather than the order of calls. The wrapper calls the job itself, so callers
 * write `compat("22")` rather than `compat("22")()`.
 */
export const compat = (node: string) =>
  ci.job(`compat (node:${node})`, async () => {
    await from(setup);
    await $`node --version`;
    await $`pnpm test`.cwd(appDir).env({ NODE_VERSION: node });
    return node;
  })();

/**
 * A job with no commands never gets a machine. The deploy SDK call goes in
 * `step.run` so it happens exactly once, and its first attempt fails to show
 * what a retry looks like in the trace.
 */
export const deploy = ci.job("deploy", async () => {
  const { sha } = github.repo();

  return step.run("create-deployment", () =>
    deploys.create({ sha, environment: "preview" }),
  );
});

/**
 * `e2e` starts a server in the background on its own machine and waits for it
 * to answer before running the tests against it.
 */
export const e2e = (baseUrl: string) =>
  ci.job("e2e", async () => {
    await from(setup);

    await $`node -e ${"require('http').createServer((_,res)=>res.end('ok')).listen(3000)"}`.background();
    await waitForHttp("http://127.0.0.1:3000");

    await $`node -e ${"console.log('e2e against ' + process.env.BASE_URL)"}`.env(
      { BASE_URL: baseUrl },
    );

    return { testedAgainst: baseUrl };
  })();

/**
 * An extra machine, for work that needs two machines alive at once.
 */
export const twoMachines = ci.job("two-machines", async () => {
  const api = await sandbox("api");
  await api.$`node -e ${"require('http').createServer((_,res)=>res.end('ok')).listen(3000)"}`.background();
  await api.waitForPort(3000);

  await checkout();
  await $`node --version`;
});

/**
 * Every Octokit REST method is available, and each call is its own step.
 */
export const release = ci.job("release", async () => {
  const approval = await step.waitForEvent("approval", {
    event: "release/approved",
    timeout: "24h",
  });

  if (!approval) {
    return { released: false, reason: "not approved in 24h" };
  }

  const { sha } = github.repo();

  const created = await github.rest.repos.createRelease({
    tag_name: `v0.0.0-ci-${sha.slice(0, 7)}`,
    generate_release_notes: true,
  });

  await github.forcePushRef("heads/ci-example-next", sha);
  await github.stickyComment("release", `Released ${created.html_url}`);

  return { released: true, url: created.html_url };
});
