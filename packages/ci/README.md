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

A pipeline run is one trace. `base` runs once, in a run of its own that the trace links to, and `lint` and `test` start from a snapshot of it. A failed command runs again without rerunning the jobs that passed.

Calling a job runs it every time you call it. Starting `from` a job builds it in a run of its own, so a job you both call and start from runs twice.

## Caching

A job with a `cache` key is reused until its key changes. Add `maxAge` to rebuild it on a schedule too: a snapshot older than that counts as a miss, and the new one takes its name.

```ts
const base = ci.job(
  { id: "base", cache: { key: files("images/node-base/**"), maxAge: "1d" } },
  async () => {
    await checkout();
    await $`pnpm install`;
  },
);
```

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
