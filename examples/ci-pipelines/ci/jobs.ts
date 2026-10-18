import {
  $,
  files,
  github,
  report,
  sandbox,
  waitForHttp,
} from "@inngest/ci";
import { step } from "inngest";

import { ci } from "./client.ts";
import { appDir, install } from "./helpers.ts";

export const base = ci.job(
  {
    id: "base",
    cache: {
      key: files("examples/ci-pipelines/app/package.json", "pnpm-lock.yaml"),
      refresh: [{ cron: "0 3 * * *" }],
    },
  },
  async () => {
    await install();
  },
);

export const lint = ci.job({ id: "lint", from: base }, async () => {
  await $`pnpm lint`.cwd(appDir);
});

export const test = ci.job({ id: "test", from: base }, async () => {
  const result = await $`pnpm test`.cwd(appDir).retries(1);

  await report.summary(`Tests exited with ${result.exitCode}`);
});

export const compat = ci.matrix(
  { id: "compat", axes: { node: ["20", "22"] }, from: base },
  async ({ node }) => {
    await $`node --version`;

    await $`pnpm test`.cwd(appDir).env({ NODE_VERSION: node });
  },
);

export const e2e = ci.job({ id: "e2e", from: base }, async () => {
  await $`node -e ${"require('http').createServer((_,res)=>res.end('ok')).listen(3000)"}`.background();
  await waitForHttp("http://127.0.0.1:3000");

  await $`curl -fsS http://127.0.0.1:3000`;
});

export const twoMachines = ci.job("two-machines", async () => {
  const api = await sandbox("api");
  await api.$`node -e ${"require('http').createServer((_,res)=>res.end('ok')).listen(3000)"}`.background();
  await api.waitForPort(3000);

  await $`node --version`;
});

export const release = ci.job("release", async () => {
  const { sha, number } = github.repo();

  const approval = await step.waitForEvent("approval", {
    event: "release/approved",
    if: `async.data.sha == "${sha}"`,
    timeout: "24h",
  });

  if (!approval) {
    await report.summary("Not approved in 24h, so nothing was released.");

    return;
  }

  const created = await github.rest.repos.createRelease({
    tag_name: `v0.0.0-ci-${sha.slice(0, 7)}`,
    generate_release_notes: true,
  });

  await github.forcePushRef("heads/ci-example-next", sha);

  if (number) {
    await github.stickyComment("release", `Released ${created.html_url}`);
  }
});
