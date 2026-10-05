# @inngest/ci

> [Inngest Labs](https://www.inngest.com/docs/labs/ci): write CI pipelines in TypeScript and run every job on its own Inngest Sandbox.

`@inngest/ci` turns plain TypeScript functions into CI pipelines. Inngest runs each pipeline as a durable function and each job on its own [Sandbox](https://www.inngest.com/docs/sandboxes/overview), an ephemeral microVM. One run produces one trace that covers the pipeline, its jobs, and every command.

> [!NOTE]
> `@inngest/ci` is an [Inngest Labs](https://www.inngest.com/docs/labs) project: something we are building on the Inngest platform in the open. It is early, moving fast, and shaped by your feedback, so APIs may change between 0.x releases. Sandboxes are in open beta.

With `@inngest/ci` you get:

- **Plain TypeScript, not YAML.** Use `if`, loops, `Promise.all`, types, and your own SDKs.
- **Durable jobs.** Inngest saves finished commands and steps. A retry never reruns work that already passed.
- **Jobs that start from other jobs.** `from()` starts a job on a copy of another job's machine, like Docker layers.
- **The same code locally.** Run a pipeline against the Dev Server with your uncommitted changes.
- **GitHub checks.** One check for each pipeline and one for each job.
- **Flow control.** Cancel superseded runs, cap concurrency, debounce, throttle, and rate limit pipelines.

## Contents

- [Example](#example)
- [Quick start](#quick-start)
- [See the result](#see-the-result)
- [Run on GitHub](#run-on-github)
- [Concepts](#concepts)
  - [Pipelines](#pipelines)
  - [Triggers](#triggers)
  - [Jobs](#jobs)
  - [Commands](#commands)
  - [Machines](#machines)
  - [Starting from another job](#starting-from-another-job)
  - [Extra machines](#extra-machines)
  - [Matrices](#matrices)
  - [Caching](#caching)
  - [Checks and reports](#checks-and-reports)
  - [GitHub](#github)
  - [Steps inside jobs](#steps-inside-jobs)
- [Recipes](#recipes)
- [Next steps](#next-steps)

## Example

This pipeline runs on every pull request. `base` installs dependencies once. `lint` and `test` each start from a copy of the `base` machine and run in parallel.

```ts
import { Inngest } from "inngest";
import { createCi, github, checkout, from, $ } from "@inngest/ci";

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

const lint = ci.job("lint", async () => {
  await from(base);
  await $`pnpm lint`;
});

const test = ci.job("test", async () => {
  await from(base);
  await $`pnpm test`.retries(1);
});
```

`base` runs once, however many jobs start from it. If `pnpm test` exits non-zero, `.retries(1)` runs it again on the same machine, and each attempt is its own step in the trace. If it still fails, the `test` check fails and the run ends. Inngest does not retry a run for a failed command.

If a step fails for another reason, such as a GitHub API 503, Inngest retries that step and replays the saved results. `base`, `lint`, and every finished command do not run again.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inngest/inngest-js/main/packages/ci/media/pipeline-dark.svg">
  <img alt="A pull request triggers the pr pipeline. The base job runs on machine A and takes a snapshot. The lint and test jobs start in parallel on copies of that snapshot. The test command fails and runs again on the same machine, while base and lint do not rerun. Each job reports a GitHub check." src="https://raw.githubusercontent.com/inngest/inngest-js/main/packages/ci/media/pipeline-light.svg">
</picture>

A pipeline run is one trace. `lint` and `test` start from a snapshot of `base`, and a failed command runs again without rerunning the jobs that passed.

## Quick start

Run the example above against the Dev Server. Checks print to your terminal.

### Before you start

- Node.js 20 or newer.
- `inngest` 4.22.0 or newer.
- An Inngest account with access to Sandboxes.
- A git repository with `lint` and `test` scripts in `package.json`.
- The Inngest CLI, signed in once:

```bash
npx inngest-cli@latest login
```

### 1. Install the packages

```bash
npm install @inngest/ci inngest
```

### 2. Create the client

`ci/client.ts`

```ts
import { Inngest } from "inngest";
import { createCi } from "@inngest/ci";

export const inngest = new Inngest({ id: "my-app" });
export const ci = createCi(inngest);
```

In dev mode, `createCi` prints checks to the terminal with `consoleReporter()`. In production, pass a [GitHub provider](#run-on-github).

### 3. Write a pipeline

`ci/pipelines.ts`

```ts
import { github, checkout, from, $ } from "@inngest/ci";
import { ci } from "./client";

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

const lint = ci.job("lint", async () => {
  await from(base);
  await $`pnpm lint`;
});

const test = ci.job("test", async () => {
  await from(base);
  await $`pnpm test`.retries(1);
});
```

### 4. Serve the pipelines

`ci/server.ts`

```ts
import { createServer } from "inngest/node";
import { inngest, ci } from "./client";
import "./pipelines";

const server = createServer({ client: inngest, functions: ci.functions() });

server.listen(3000);
```

`ci.functions()` returns your pipelines plus the functions CI needs behind the scenes: machine cleanup and cache refreshes.

### 5. Run locally

Start the Dev Server and your app in two terminals:

```bash
npx inngest-cli@latest dev
```

```bash
INNGEST_DEV=1 npx tsx ci/server.ts
```

Send a pull request event built from your current checkout:

`ci/send.ts`

```ts
import { fixtures } from "@inngest/ci";
import { inngest } from "./client";

async function main() {
  await inngest.send(await fixtures.pullRequest());
}

main();
```

```bash
INNGEST_DEV=1 npx tsx ci/send.ts
```

`checkout()` uploads your working tree, including uncommitted changes and excluding ignored files. The upload is limited to 100 MiB.

### Cleanup and current behavior

- Inngest destroys every machine when the pipeline ends. A separate function destroys machines left behind by a run that failed or was cancelled.
- The Dev Server runs commands on Sandboxes in your Inngest account, so you need `inngest login`. There is no local Sandbox runtime yet.
- Output from a command arrives when the command ends, not while it runs.

## See the result

Every run opens in the Inngest dashboard as one trace: the pipeline, each job, each command, and the Sandbox steps behind them.

![The trace of the example pr pipeline in the Inngest Dev Server: pipeline and job checks, cache lookups, then the base job creating its machine, checking out the repository and installing dependencies](https://raw.githubusercontent.com/inngest/inngest-js/main/packages/ci/media/trace.png)

On GitHub, the same run appears as one check for the pipeline and one for each job:

```
✕ pr             test: `pnpm test` exited with 1
✓ pr / base      Passed in 41s
✓ pr / lint      Passed in 22s
✕ pr / test      `pnpm test` exited with 1
```

In dev mode the same transitions print to the terminal:

```
[pr] … pr / test
[pr] ✕ pr / test  `pnpm test` exited with 1  → http://localhost:8288/run?runID=01J…
```

## Run on GitHub

In production, pipelines start from GitHub webhooks and report checks as a GitHub App.

1. Create a GitHub App with these repository permissions: Checks (read and write), Commit statuses (read and write), Contents (read), Pull requests (read and write), Issues (read and write), Metadata (read).
2. Subscribe the app to these events: push, pull request, check run, check suite, issue comment, merge group, and workflow run.
3. In the Inngest dashboard, create a webhook and paste the output of `githubWebhookTransform` into its transform. Use the webhook URL as the app's webhook URL.

   ```bash
   node --input-type=module -e "import { githubWebhookTransform as t } from '@inngest/ci'; console.log(t)"
   ```

4. Install the app on your repositories.
5. Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, then pass the provider to `createCi`:

`ci/client.ts`

```ts
import { Inngest } from "inngest";
import { createCi, githubApp } from "@inngest/ci";

export const inngest = new Inngest({ id: "my-app" });
export const ci = createCi(inngest, {
  github: githubApp({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  }),
});
```

- `githubApp()` reports checks with the Checks API. `githubToken()` reports commit statuses instead, with no summaries or annotations.
- In dev mode checks print to the terminal. Set `INNGEST_CI_GITHUB=live` to send real checks from the Dev Server.

> [!WARNING]
> Inngest does not verify webhook signatures yet. Keep the webhook URL secret.

## Concepts

### Pipelines

A **pipeline** runs when something happens and calls jobs. It is one Inngest function, so every Inngest flow control option works on it.

```ts
export const pr = ci.pipeline(
  {
    id: "pr",
    on: github.pullRequest(),
    singleton: { key: "event.data.pull_request.number", mode: "cancel" },
    concurrency: {
      key: "event.data.repository.owner.login",
      limit: 20,
      scope: "account",
    },
  },
  async ({ event }) => {
    await test();
    await deploy(event.data.pull_request.head.sha);
  },
);
```

The handler receives `event`, `events`, `runId`, `pipelineId`, `repo`, `attempt`, and `logger`. `repo` is `undefined` for triggers that carry no repository, such as a cron.

| Option | Type | Required |
| --- | --- | --- |
| `id` | `string` | Yes |
| `on` | A trigger, or an array of triggers | Yes |
| `check` | `false`, or `{ name?, jobs? }` | No |
| `machine` | `{ vcpu?: 1 \| 2 \| 4 }` | No |
| `repo` | `string` | No |

- `id` is unique in the app. It names the function, the run, and the check.
- `check: false` turns off all checks. `check: { jobs: false }` keeps the pipeline check and drops the job checks.
- `machine` is the default machine for the pipeline's jobs. A job's own `machine` overrides it. See [Machines](#machines).
- `repo` (`"owner/name"`) gives crons and manual runs a repository to check out.
- Flow control options: `concurrency`, `throttle`, `rateLimit`, `debounce`, `priority`, `singleton`, `idempotency`, `batchEvents`, `timeouts`, `cancelOn`, `retries`, `name`, and `description`. See [flow control](https://www.inngest.com/docs/durable-execution/flow-control/concurrency).

Return `ci.skip(reason)` to end a run early. The check completes as success with the reason, so a required check never waits.

```ts
const touched = await changed("src/**", "package.json");

if (touched === false) {
  return ci.skip("nothing that affects the build changed");
}
```

`changed()` reads the pull request files, or the push range, before any machine starts. When it cannot read the change, it returns `true` and notes it on the check.

### Triggers

A **trigger** starts a pipeline and types its `event`.

| Trigger | Runs when |
| --- | --- |
| `github.pullRequest({ branches, types, repo })` | A pull request opens, is pushed to, or reopens. `types` changes the actions. |
| `github.push({ branches, tags, repo })` | Commits are pushed. Deleted branches are excluded. |
| `github.comment({ command, minPermission, repo })` | A comment starts with `command`. |
| `github.mergeGroup({ repo })` | The merge queue asks for checks. |
| `github.checkSuite({ branch, repo })` | A check suite completes. |
| `{ cron: "0 3 * * *" }` | The schedule fires. |
| `ci.manual({ schema, pipelineId })` | An event named `ci/manual.<pipelineId>` arrives. |

Pass an array for several triggers. `event.data` is typed by the triggers you pass:

```ts
export const merged = ci.pipeline(
  {
    id: "merged",
    on: github.pullRequest({ types: ["closed"] }),
  },
  async ({ event }) => {
    if (event.data.pull_request.merged === false) {
      return ci.skip("closed without merging");
    }

    await release();
  },
);
```

- `pullRequest()` defaults to `opened`, `synchronize`, and `reopened`.
- A pipeline has at most 10 triggers, and `pullRequest()` uses one for each type.
- `comment({ minPermission })` checks the author after the run starts. A user without the permission gets a reply and a neutral check.
- Several triggers give a union type. Narrow it with `"pull_request" in event.data`.
- A cron has no typed `event.data`. `ci.manual({ schema })` types it from any Standard Schema validator, such as Zod.

### Jobs

A **job** is a unit of work with its own machine and its own check. Call it like a function.

```ts
const test = ci.job("test", async () => {
  await checkout();
  await $`pnpm install`;
  await $`pnpm test`;
});

const build = ci.job({ id: "build", machine: { vcpu: 4 } }, async () => {
  await checkout();
  await $`pnpm build`;
  return { builtAt: Date.now() };
});
```

- A job returns its handler's value.
- A job runs once per run for each ID. A second call returns the first call's result, so two callers share one run.
- The machine starts on the job's first command. A job with no commands never gets one.
- Jobs never share a machine. To reuse work, use [`from()`](#starting-from-another-job).
- When a command fails, the job's check fails and the pipeline ends.

| Option | Type | Required |
| --- | --- | --- |
| `id` | `string` | Yes |
| `machine` | `{ vcpu?: 1 \| 2 \| 4 }` | No |
| `cache` | `{ key?, refresh?, scope? }` | No |
| `check` | `false`, or `{ name? }` | No |
| `keepOnFailure` | Duration, such as `"24h"` | No |

`keepOnFailure` snapshots the machine when the job fails. The snapshot ID appears on the job check and in the pipeline summary.

### Commands

`` $`…` `` runs a command on the job's machine. A non-zero exit code throws `CommandFailedError`.

```ts
await $`pnpm test`;
await $`pnpm --filter ${pkg} test`;
await $`pnpm test ${bail && ["--bail", "1"]}`;
```

Each interpolated value becomes one argument with no quoting. Arrays spread into several arguments, and `false`, `null`, and `undefined` are dropped.

Options chain:

```ts
await $`pnpm test`.retries(2);
await $`pnpm lint`.nothrow();
await $`pnpm test`.env({ CI: "true" });
await $`pnpm test`.cwd("/work/app");
await $`pnpm test`.timeout("10m");
await $`pnpm exec playwright test`.as("e2e");
await $`pnpm publish`.withSecret("NPM_TOKEN", token);

const sha = await $`git rev-parse HEAD`.text();
const tracked = await $`git ls-files`.lines();
const meta = await $`cat package.json`.json<{ name: string }>();

await $.sh`pnpm build && pnpm test | tee test.log`;
```

| Method | Does |
| --- | --- |
| `.retries(n)` | Runs the command up to `n` more times on the same machine. Each attempt is a step. |
| `.nothrow()` | Returns the result with its exit code instead of throwing. |
| `.env(vars)` | Sets environment variables for this command. |
| `.cwd(path)` | Sets the directory. The default is `/work`. |
| `.timeout(duration)` | Throws `CommandTimeoutError` after the duration. |
| `.onTimeout(fn)` | Runs `fn` when the timeout hits, then throws. |
| `.background()` | Starts the command and returns a process with `id`, `exited()`, `kill(signal?)`, and `output({ tailBytes? })`. |
| `.as(name)` | Names the step in the trace. |
| `.withSecret(name, value)` | Passes an environment variable and masks it in output. |
| `.text()`, `.lines()`, `.json()` | Returns stdout as a trimmed string, an array of lines, or parsed JSON. |

- `$` runs without a shell. `$.sh` runs `/bin/sh -c` and escapes interpolated values.
- A result holds `exitCode`, `stdout`, `stderr`, `truncated`, and `durationMs`. `stdout` and `stderr` keep the last 64 KiB. `durationMs` is missing when the Sandbox API doesn't time the command, which today is any command with a timeout of 5 minutes or less.
- `$` outside a job throws `CiUsageError`.
- `.background()` returns once the process starts. `kill()` sends `SIGTERM` unless you pass a signal number, `output()` reads the last 64 KiB by default, and `exited()` polls for exit. It ignores `.retries()`, `.timeout()`, and `.nothrow()`.
- Output arrives when the command ends. A `.timeout()` of 5 minutes or less is exact. A longer one is approximate because Inngest polls for exit.

> [!WARNING]
> `.withSecret()` hides the value from the trace and from check output. Code running on the machine can still read it.

Any function can run commands. It uses the calling job's machine:

```ts
export async function install() {
  await checkout();
  await $`pnpm install --frozen-lockfile`;
}

const test = ci.job("test", async () => {
  await install();
  await $`pnpm test`;
});
```

### Machines

A **machine** is a Sandbox: an ephemeral Linux microVM. Each job gets one on its first command.

| `vcpu` | Memory |
| --- | --- |
| 1 | 1 GiB |
| 2 (default) | 2 GiB |
| 4 | 4 GiB |

Set `machine` on a job, on its pipeline, or on `createCi` for every job. The first one set wins in that order, and the default is 2 vCPUs.

- Inngest pauses a machine when its job finishes, so a later `from()` can snapshot it, and destroys every machine when the pipeline ends.
- Only `$` runs on the machine. The rest of your handler runs in your app.
- Commands run in `/work` by default, which is where `checkout()` puts the repository.
- `checkout()` clones the commit that triggered the run with a short-lived token that never appears in the trace. Locally it uploads your working tree.

`checkout()` options: `ref`, `submodules`, `history` (`"shallow"` or `"full"`), and `path`. `history` defaults to `"shallow"`, which skips file contents until they are needed, and `path` defaults to `/work`. Commands after a `checkout({ path })` run in that path. A local checkout uploads your working tree and ignores `ref`, `submodules`, and `history`. `checkout()` throws `CiUsageError` when the run has no repository, so set `repo` on the pipeline.

### Starting from another job

`from(job)` starts the current job on a copy of another job's machine, like a Docker layer. The parent runs once, however many jobs start from it, and each child gets its own isolated copy.

```ts
const base = ci.job("base", async () => {
  await checkout();
  await $`pnpm install`;
});

const build = ci.job("build", async () => {
  await from(base);
  await $`pnpm build`;
});

const test = ci.job("test", async () => {
  await from(build);
  await $`pnpm test`;
});
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/inngest/inngest-js/main/packages/ci/media/from-dark.svg">
  <img alt="Three jobs layered with from(): base, build, and test. In the first run all three run. In the second run the base cache key is unchanged, so base is restored without running. The build key changed, so build runs again from the base snapshot, and test runs from the new build snapshot." src="https://raw.githubusercontent.com/inngest/inngest-js/main/packages/ci/media/from-light.svg">
</picture>

Each job builds on the snapshot of the one before it. When a job's [cache key](#caching) is unchanged, Inngest skips the job and restores its saved machine. When a cached job's key changes, it runs again, and so does every cached job that starts from it, directly or through other cached jobs.

- `from()` returns the parent's result. Pass the parent's input as the second argument when it takes one.
- Call `from()` before the job's first command, and once per job.
- `await base()` runs `base` on its own machine. `await from(base)` runs it and then starts this job from where it finished.
- Choose the parent at runtime:

  ```typescript {{ title: "TypeScript" }}
  await from((await changed("docs/**")) ? docsBase : base);
  ```

- If a snapshot is not available, the job runs the parent's commands again on its own machine. Every child repeats the parent's work in that case.

### Extra machines

`sandbox(name)` creates another machine for the job. It is destroyed with the pipeline and appears under the job in the trace.

```ts
const e2e = ci.job("e2e", async () => {
  await checkout();

  const probe = await sandbox("probe", { vcpu: 1 });
  await probe.$`pnpm dlx serve -l 3000`.background();
  await probe.waitForPort(3000);
  await probe.waitForHttp("http://127.0.0.1:3000");

  await $`pnpm exec playwright test`;
});
```

- Plain `$` still runs on the job's own machine.
- An extra machine starts empty. `checkout()` runs on the job's machine only.
- `ExtraMachine` has `$`, `$.sh`, `waitForPort()`, and `waitForHttp()`.

> [!WARNING]
> Machines cannot reach each other yet. Run servers your tests call on the job's own machine and use `127.0.0.1`.

| If the work… | Use |
| --- | --- |
| Is independent | Separate jobs |
| Builds on earlier work | Separate jobs with `from()` |
| Needs a second machine alive at the same time | One job with `sandbox()` |

### Matrices

`ci.matrix` runs a job for every combination of its axes. Each combination is its own job with its own check and retries.

```ts
const compat = ci.matrix(
  {
    id: "compat",
    axes: { node: ["20", "22", "24"], db: ["sqlite", "postgres"] },
    exclude: [{ node: "20", db: "postgres" }],
    concurrency: 3,
  },
  async ({ node, db }) => {
    await from(base);
    await $`pnpm test`.env({ NODE_VERSION: node, TEST_DATABASE: db });
  },
);

export const nightly = ci.pipeline(
  { id: "nightly", on: { cron: "0 3 * * *" }, repo: "my-org/my-app" },
  async () => {
    await compat();
  },
);
```

Call `compat()` to run every combination, or `compat({ node: "22" })` to run only the matching ones.

- Job IDs come from the values, such as `compat (node:22, db:sqlite)`. Adding a value does not change the others.
- `exclude` removes combinations and `include` adds extra ones.
- `concurrency` limits how many run at once. The default is all of them.
- `failFast` is off by default. When it is on, the first failure ends the matrix, and running combinations are not cancelled.
- `machine`, `cache`, and `check` accept a value or a function of the combination.
- With `failFast` off, failures are thrown together as an `AggregateError` after every combination finishes.

### Caching

A job's `cache` reuses its last result when nothing it depends on has changed.

```ts
const base = ci.job(
  {
    id: "base",
    cache: {
      key: files("pnpm-lock.yaml", ".nvmrc"),
      refresh: [{ cron: "0 3 * * *" }],
    },
  },
  async () => {
    await checkout();
    await $`pnpm install`;
  },
);
```

- `key` is what the job depends on. If the key is unchanged since the last successful run, the job does not run. A job that started a machine is restored from its snapshot, and `from(base)` clones the saved machine.
- `refresh` takes triggers that rebuild the cache ahead of time, so pull requests do not pay for it. Set `repo` on a pipeline so a cron has a repository to check out.
- `scope` is `"branch"` by default. A pull request reads entries from its base branch and writes its own. `"global"` shares one entry set.

```ts
key: files("pnpm-lock.yaml")
key: files("migrations/**", "seeds/**")
key: [files("go.mod", "go.sum"), "go1.25"]
```

- `files()` hashes the matched files in the git tree for the run's commit. Locally it hashes the working tree.
- A cached job also depends on the cached jobs it starts `from()`. When one of them changes its key, the child's entry is stale and the job runs again. This holds up the whole chain of cached parents. An uncached parent has no key and never invalidates its children, so add its files to the child's key when the child depends on them.
- The first run of a job always misses.
- A job without a machine caches its result. Reused jobs show as passed.
- Do not cache tests that call the network.

Entries live in a `CacheStore`. The default is `memoryCacheStore()`, which lasts as long as the process. `fileCacheStore(dir)` writes JSON files, `.inngest/ci-cache` by default. Pass your own `{ get, set }` object to keep entries anywhere:

```ts
export const ci = createCi(inngest, {
  cacheStore: fileCacheStore(".inngest/ci-cache"),
});
```

> [!WARNING]
> There is no hosted cache store yet. A memory store on a serverless deploy misses on every cold start, so use a file store on shared storage or your own store.

### Checks and reports

Checks are automatic: one for the pipeline and one for each job. Require the pipeline check in branch protection.

| State | Check |
| --- | --- |
| Running | In progress, with the current command |
| Retrying a command | In progress, with the attempt count and the last error |
| Passed | Success, with the duration |
| Reused from cache | Success, with `Restored, built …` or `Passed at <sha>, no changes since` |
| Failed | Failure, with the command, the output tail, and annotations |
| Timed out | Timed out |
| Cancelled by a failure elsewhere | Cancelled |
| Returned `ci.skip()` | Success, with the reason |
| Job never called | No check |

`report` adds to the current job's check. Outside a job it targets the pipeline check.

```ts
await report.summary(`Coverage: **${coverage}%**`);
await report.annotate([
  { path: "src/queue.ts", line: 42, message: "Flaky retry here" },
]);
```

- `report.summary(markdown)` stacks sections. Inngest truncates a summary at 65,000 bytes, under GitHub's limit of 65,535 bytes, and links to the trace.
- `report.annotate(annotations)` puts annotations on the diff. Inngest sends them in batches of 50, the GitHub limit per request. Entries without a `path` or a `message` are dropped.
- A GitHub "Re-run" on a pipeline or job check, or "Re-run all" on the check suite, restarts the whole pipeline. Passed jobs are reused only when they have a `cache` key.

### GitHub

`github` has the triggers above, the GitHub REST API, and a few helpers.

#### `github.rest`

Every Octokit REST method, with each call recorded as a step.

```ts
const release = ci.job("release", async () => {
  const created = await github.rest.repos.createRelease({
    tag_name: "v1.4.0",
    generate_release_notes: true,
  });

  await github.rest.git.updateRef({
    ref: "heads/next",
    sha: github.repo().sha,
    force: true,
  });

  return created.html_url;
});

await github.rest.with({ id: "tag-release" }).git.createRef({ ref: "refs/tags/v1.4.0", sha });
```

- `owner` and `repo` default to the run's repository.
- A call returns the response `data`. Results are JSON, so dates are strings. Keep them small.
- A rate limit retries after the reset time, other 4xx errors do not retry, and 5xx errors retry.
- Streaming methods are not supported. Use `github.octokit()` inside `step.run`.
- Inside `step.run`, or outside a pipeline, calls run directly.

#### Helpers

| Helper | Does |
| --- | --- |
| `github.stickyComment(key, body)` | Creates one pull request comment and updates it on later runs. |
| `github.upsertPullRequest({ head, base, title, body })` | Opens a pull request or updates the open one. |
| `github.forcePushRef(ref, sha)` | Moves or creates a branch or tag. |
| `github.canUser(login, permission)` | Checks a user's permission on the repository. |
| `github.waitForChecks({ names, sha, timeout })` | Waits for other checks on a commit, with no machine. The default timeout is `1h`. |
| `github.waitForWorkflow({ workflow, sha, timeout })` | Waits for a GitHub Actions workflow run. |
| `github.paginate(method, params)` | Fetches every page of a list method, typed. |
| `github.graphql(query, variables)` | Runs a GraphQL query. |
| `github.repo()` | Returns `owner`, `repo`, `sha`, `number`, and `ref`. |
| `github.token()` | Returns a short-lived installation token. `step.run` only. |
| `github.octokit()` | Returns a plain Octokit client. `step.run` only. |

> [!WARNING]
> `github.waitForChecks()` can miss a check that finishes between the lookup and the wait. That name then times out.

### Steps inside jobs

A job is an Inngest function body, so the full Inngest step API works inside it. Import `step` from `inngest`.

```ts
import { step } from "inngest";

const migrations = ci.job("migrations", async () => {
  const db = await step.run("create-db-branch", async () => {
    return neon.branches.create({ parent: "main" });
  });

  await checkout();
  await $`pnpm install`;
  await $`pnpm db:migrate`.env({ DATABASE_URL: db.url });

  await step.run("delete-db-branch", async () => {
    return neon.branches.delete(db.id);
  });
});
```

- Commands are steps and do not rerun. Other code in a job can run again when the run resumes, so wrap side effects in `step.run`.
- Step IDs are scoped to the job, so two jobs can use the same ID.
- `step.waitForEvent`, `step.sleep`, and `step.invoke` work, and a wait holds no worker.
- Throw `RetryAfterError` from `inngest` to retry a step after a delay.

## Recipes

### Services and waiting

| Task | Code |
| --- | --- |
| Start a server | `` const server = await $`pnpm start`.background() `` |
| Wait for a port | `await waitForPort(3000)` |
| Wait for a health check | `await waitForHttp("http://127.0.0.1:3000/health")` |
| Read server logs | `await server.output()` |
| Stop a server | `await server.kill()` |
| Wait for other checks | `await github.waitForChecks({ names: ["vercel"] })` |
| Wait for an Actions workflow | `await github.waitForWorkflow({ workflow: "npm_test.yml" })` |
| Run another pipeline | `await step.invoke("contracts", { function: contracts, data: { sha } })` |

### Tests

| Task | Code |
| --- | --- |
| Build once, test many | `await from(build)` |
| Skip unchanged tests | `cache: { key: files("src/**", "test/**") }` |
| Retry a flaky command | `` await $`pnpm test`.retries(2) `` |
| Split tests across machines | `ci.matrix` over shard indexes with `shard()` |

Split test files across a matrix with `shard()`, which splits by count:

```ts
const unit = ci.matrix(
  { id: "unit", axes: { shard: [0, 1, 2, 3] } },
  async ({ shard: index }) => {
    await from(base);
    const all = await $`git ls-files "*.test.ts"`.lines();

    await shard({ total: 4, index, files: all }, async (chunk) => {
      return $`pnpm vitest run ${chunk}`;
    });
  },
);
```

Dump process state when a command hangs:

```ts
await $`pnpm test`.timeout("10m").onTimeout(async () => {
  return $`ps auxf`;
});
```

### Pull requests

| Task | Code |
| --- | --- |
| Post a sticky comment | `` await github.stickyComment("preview", `Preview: ${url}`) `` |
| Annotate the diff | `await report.annotate([{ path, line, message }])` |
| Add a check summary | `await report.summary("**Coverage:** 91%")` |
| Open or update a pull request | `await github.upsertPullRequest({ head: "release/next", title, body })` |
| Alert on a broken main | A pipeline on `github.checkSuite({ branch: "main" })` |

### Changes and triggers

| Task | Code |
| --- | --- |
| Run on changed files | `if (await changed("docs/**")) { await docsSite(); }` |
| Skip a whole run | `return ci.skip("nothing changed")` |
| Watch another repository | `on: github.push({ repo: "inngest/inngestgo", branches: ["main"] })` |
| Slash commands | `on: github.comment({ command: "/prerelease", minPermission: "write" })` |
| Typed manual runs | `on: ci.manual({ pipelineId: "deploy", schema: z.object({ env: z.enum(["preview", "production"]) }) })` |
| Move a branch with no machine | `await github.forcePushRef("heads/next", sha)` |
| Cancel superseded runs | `singleton: { key: "event.data.pull_request.number", mode: "cancel" }` |

### Debugging

| Task | Code |
| --- | --- |
| Keep a failed machine | `ci.job({ id: "test", keepOnFailure: "24h" }, fn)` |
| Name a command in the trace | `` await $`pnpm test`.as("unit tests") `` |
| Turn off a job's check | `ci.job({ id: "notify", check: false }, fn)` |
| Rename the pipeline check | `check: { name: "CI" }` |

## Next steps

- [Sandboxes](https://www.inngest.com/docs/sandboxes/overview): the microVMs that run every job, with limits and snapshots.
- [Durable execution](https://www.inngest.com/docs/durable-execution): how Inngest saves steps, retries failed work, and resumes runs.
- [Flow control](https://www.inngest.com/docs/durable-execution/flow-control/concurrency): concurrency, throttling, debounce, and the other options a pipeline accepts.
- [`examples/ci-pipelines`](https://github.com/inngest/inngest-js/tree/main/examples/ci-pipelines): a runnable example with pipelines, matrices, caching, and GitHub checks.
- [Dev Server](https://www.inngest.com/docs/dev-server): run pipelines locally and inspect traces.
