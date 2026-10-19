# @inngest/ci

> [Inngest Labs](https://www.inngest.com/docs/labs/ci): write CI pipelines in TypeScript and run every job on its own Inngest Sandbox.

> [!NOTE]
> `@inngest/ci` is an [Inngest Labs](https://www.inngest.com/docs/labs) project: something we are building on the Inngest platform in the open. It is early, moving fast, and shaped by your feedback, so APIs may change between 0.x releases. Sandboxes are in open beta.

`@inngest/ci` turns plain TypeScript functions into CI pipelines. Inngest runs each pipeline as a durable function and each job on its own [Sandbox](https://www.inngest.com/docs/sandboxes/overview), an ephemeral microVM. One run produces one trace that covers the pipeline, its jobs, and every command.

- **Plain TypeScript.** Use `if`, loops, `Promise.all`, types, and your own SDKs. [Pipelines](https://www.inngest.com/docs/labs/ci/pipelines)
- **Durable jobs.** A retry never reruns work that already passed. [Concepts](https://www.inngest.com/docs/labs/ci/concepts)
- **Jobs that start from other jobs.** `from` starts a job on a copy of another job's machine. [Machines](https://www.inngest.com/docs/labs/ci/machines#start-a-job-from-another-job)
- **GitHub checks.** One check for each pipeline and one for each job. [Checks and reports](https://www.inngest.com/docs/labs/ci/checks-and-reports)
- **Flow control.** Cancel superseded runs, cap concurrency, debounce, throttle, and rate limit. [Flow control](https://www.inngest.com/docs/labs/ci/pipelines#flow-control)

## Example

This pipeline runs on every pull request. `base` installs dependencies once. `lint` and `test` each start from a copy of the `base` machine and run in parallel.

```ts
import { Inngest } from "inngest";
import { createCi, github, checkout, $ } from "@inngest/ci";

const inngest = new Inngest({ id: "my-app" });
const ci = createCi(inngest);

export const pr = ci.pipeline(
  {
    id: "pr",
    on: github.pullRequest(),
    singleton: { key: "event.data.pull_request.number", mode: "cancel" },
  },
  async () => {
    await Promise.all([lint(), test()]);
  },
);

const base = ci.job("base", async () => {
  await checkout();
  await $`pnpm install`;
});

const lint = ci.job({ id: "lint", from: base }, async () => {
  await $`pnpm lint`;
});

const test = ci.job({ id: "test", from: base }, async () => {
  await $`pnpm test`.retries(1);
});
```

A pipeline run is one trace. `lint` and `test` start from a snapshot of `base`, and a failed command runs again without rerunning the jobs that passed.

## Caching

A job with a `cache` key is reused until its key changes. Add `maxAge` to rebuild it on a schedule too: a snapshot older than that counts as a miss, and the new one takes its name. Every duration in `@inngest/ci` (`maxAge`, `.timeout()`, `waitForPort`, `waitForHttp`, `github.waitForChecks`) takes milliseconds, an `ms` string like `"30s"` or `"1h30m"`, or a `Temporal.Duration`. A bare number in a string (`"10"`) means milliseconds.

```ts
const base = ci.job(
  { id: "base", cache: { key: files("images/node-base/**"), maxAge: "1d" } },
  async () => {
    await checkout();
    await $`pnpm install`;
  },
);
```

## What a job is given

A handler gets the job's `id`, its `input`, the resolved `key` of its cache, and what it started `from`. Name the parts of a key to read them. A matrix handler also gets its combination as `matrix`.

```ts
const base = ci.job(
  {
    id: "base",
    cache: { key: { deps: files("pnpm-lock.yaml"), devServer: latestDevServer } },
  },
  async ({ key }) => {
    await $`pnpm install --dev-server ${key.devServer}`;
  },
);

const test = ci.job({ id: "test", from: base }, async ({ from }) => {
  from.key.devServer; // the key parts of everything it started from
  from.ancestry; // each job above it, nearest first: [{ id, key, output }, ...]
});

ci.matrix({ id: "compat", axes: { node: ["20", "22"] } }, async ({ matrix }) => {
  await $`fnm use ${matrix.node}`;
});
```

Each part of a key is resolved once, and the same value is used to find the snapshot and to build it. The same goes for a job that starts from another app's `image.job()`.

## What a job returns

Return an object of JSON values and commands. Jobs that start from it get the data as `from.output` and the commands as `$from`, typed, merged up the chain with the nearest job winning a name.

```ts
const base = ci.job({ id: "base", cache: { key: files("pnpm-lock.yaml") } }, async () => {
  await $`pnpm install`;

  return {
    pnpmVersion: await $`pnpm --version`.text(),
    devServer: $`inngest-cli dev`,
  };
});

const test = ci.job({ id: "test", from: base }, async ({ from, $from }) => {
  from.output.pnpmVersion;

  await $from.devServer.background();
});
```

An output describes the image as it was built, so a cached job gives the same output every time without running. A command in an output is a command, not a process: nothing the job started is running in the jobs that start from it, and a command you await in the return value runs while the job builds. Outputs are stored in the image with each command's environment, so don't put secrets in either. An uncached job called from a pipeline resolves to its data.

## Start from another app's job

Share a base across apps with `image.job()`. The other app builds the job if it's missing, once for every app that asks, from the commit it was deployed from.

```ts
import { image } from "@inngest/ci";

ci.job({ id: "test", from: image.job("platform/node-base") }, async () => {
  await $`pnpm test`;
});
```

The other app finds that commit in its host's variables (Vercel or GitHub Actions) or its git checkout. Both apps run `@inngest/ci` in the same Inngest environment.

## Another repository or ref

`checkout()` and `files()` take `repo` and `ref`. A ref is a branch, tag or commit, and it's resolved to a commit once per run.

```ts
await checkout({ repo: "acme/platform" });                // default branch
await checkout({ repo: "acme/platform", ref: "v2.1.0" });
await checkout({ ref: "main" });                          // this repository

const image = ci.job(
  {
    id: "image",
    cache: {
      key: files("images/node-base/**", { repo: "acme/platform", ref: "main" }),
    },
  },
  async () => {
    await checkout({ repo: "acme/platform", ref: "main" });
  },
);
```

A run whose trigger has no repository, like a cron, needs `repo`. The GitHub App must have access to the repository. Locally, `checkout()` still uploads your working tree unless you name another repository or a `ref`.

## Install

```bash
npm install @inngest/ci inngest
```

## Get started

Follow the [Quick start](https://www.inngest.com/docs/labs/ci/quick-start) to write and serve your first pipeline.

## Learn more

- [Concepts](https://www.inngest.com/docs/labs/ci/concepts)
- [Pipelines and triggers](https://www.inngest.com/docs/labs/ci/pipelines)
- [Jobs](https://www.inngest.com/docs/labs/ci/jobs)
- [Commands](https://www.inngest.com/docs/labs/ci/commands)
- [Machines and `from`](https://www.inngest.com/docs/labs/ci/machines)
- [Caching](https://www.inngest.com/docs/labs/ci/caching)
- [Checks and reports](https://www.inngest.com/docs/labs/ci/checks-and-reports)
- [Run on GitHub](https://www.inngest.com/docs/labs/ci/reference#run-on-github)
- [Reference](https://www.inngest.com/docs/labs/ci/reference)
- [About Inngest Labs](https://www.inngest.com/docs/labs)

## Run metadata

Every pipeline run is tagged with `userland.inngest-ci` metadata, visible on the run in Inngest. It includes the package version, the repo, ref, sha and pull request number when the run has them, and usage counts for the `@inngest/ci` APIs the run used. Commands, output, and secrets are never recorded.

See [Run metadata](https://www.inngest.com/docs/labs/ci/reference#run-metadata) for every field.

## Example project

[`examples/ci-pipelines`](https://github.com/inngest/inngest-js/tree/main/examples/ci-pipelines) is a runnable example with pipelines, matrices, caching, and GitHub checks.

## Contributing

See [`AGENTS.md`](./AGENTS.md) and the README in each folder of [`src/`](./src).
