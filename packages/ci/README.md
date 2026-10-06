# @inngest/ci

> [Inngest Labs](https://www.inngest.com/docs/labs/ci): write CI pipelines in TypeScript and run every job on its own Inngest Sandbox.

`@inngest/ci` turns plain TypeScript functions into CI pipelines. Inngest runs each pipeline as a durable function and each job on its own [Sandbox](https://www.inngest.com/docs/sandboxes/overview), an ephemeral microVM. One run produces one trace that covers the pipeline, its jobs, and every command.

> [!NOTE]
> `@inngest/ci` is an [Inngest Labs](https://www.inngest.com/docs/labs) project: something we are building on the Inngest platform in the open. It is early, moving fast, and shaped by your feedback, so APIs may change between 0.x releases. Sandboxes are in open beta.

With `@inngest/ci` you get:

- **Plain TypeScript, not YAML.** Use `if`, loops, `Promise.all`, types, and your own SDKs.
- **Durable jobs.** Inngest saves finished commands and steps. A retry never reruns work that already passed.
- **Jobs that start from other jobs.** `from()` starts a job on a copy of another job's machine, like Docker layers.
- **The same code locally.** Run any pipeline or job from your terminal on real Sandboxes, against your uncommitted changes.
- **GitHub checks.** One check for each pipeline and one for each job.
- **Flow control.** Cancel superseded runs, cap concurrency, debounce, throttle, and rate limit pipelines.

## Contents

- [Example](#example)
- [Quick start](#quick-start)
- [Run locally](#run-locally)
  - [Pick what to run](#pick-what-to-run)
  - [Run one job](#run-one-job)
  - [Choose the event](#choose-the-event)
  - [Input forms](#input-forms)
  - [Open an earlier run](#open-an-earlier-run)
  - [Flags](#flags)
  - [Exit codes](#exit-codes)
  - [Configure](#configure)
  - [The Dev Server](#the-dev-server)
  - [Send an event yourself](#send-an-event-yourself)
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
  - [Local runs](#local-runs)
  - [GitHub](#github)
  - [Steps inside jobs](#steps-inside-jobs)
- [Recipes](#recipes)
- [Run metadata](#run-metadata)
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

Run the example above on your machine. Checks print to your terminal. CI lives in `ci/`, one file per job and per pipeline.

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
npm install --save-dev inngest-cli
```

`inngest-ci` starts a Dev Server from the `inngest-cli` package, or from a global install.

### 2. Create the client

`ci/client.ts`

```ts
import { Inngest } from "inngest";
import { createCi } from "@inngest/ci";

export const inngest = new Inngest({ id: "my-app" });
export const ci = createCi(inngest);
```

In dev mode, `createCi` prints checks to the terminal with `consoleReporter()`. In production, pass a [GitHub provider](#run-on-github).

### 3. Write the jobs and a pipeline

One file per job and per pipeline, named after what it holds:

```
ci/
  client.ts
  jobs/base.ts
  jobs/lint.ts
  jobs/test.ts
  pipelines/pr.ts
  index.ts
  server.ts
```

`ci/jobs/base.ts`

```ts
import { checkout, $ } from "@inngest/ci";
import { ci } from "../client";

export const base = ci.job("base", async () => {
  await checkout();
  await $`pnpm install`;
});
```

`ci/jobs/lint.ts`

```ts
import { from, $ } from "@inngest/ci";
import { ci } from "../client";
import { base } from "./base";

export const lint = ci.job("lint", async () => {
  await from(base);
  await $`pnpm lint`;
});
```

`ci/jobs/test.ts` is the same with `pnpm test`, `.retries(1)` and the id `test`.

`ci/pipelines/pr.ts`

```ts
import { github } from "@inngest/ci";
import { ci } from "../client";
import { lint } from "../jobs/lint";
import { test } from "../jobs/test";

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
```

### 4. Serve the pipelines

`ci/index.ts` imports every pipeline, so the server registers them all.

```ts
import "./pipelines/pr";

export { ci } from "./client";
```

`ci/server.ts`

```ts
import { createServer } from "inngest/node";
import { inngest } from "./client";
import { ci } from "./index";

const server = createServer({ client: inngest, functions: ci.functions() });

server.listen(Number(process.env.PORT ?? 3000));
```

`ci.functions()` returns your pipelines plus the functions CI needs behind the scenes: machine cleanup, cache refreshes, and running a single job locally. The server must listen on `PORT`, which `inngest-ci` sets.

### 5. Run it

```bash
npx inngest-ci pr
```

`inngest-ci` starts a Dev Server and `ci/server.ts`, sends a pull request event built from your current checkout, and shows the run live. `checkout()` uploads your working tree, including uncommitted changes and excluding ignored files. The upload is limited to 100 MiB.

## Run locally

`inngest-ci <target>` runs one pipeline or one job on real Sandboxes against your working tree. With no target, a terminal shows a picker. A target that needs input asks for it field by field, from its schema.

```bash
npx inngest-ci pr
npx inngest-ci lint
npx inngest-ci
```

The first time, `inngest-ci` finds how your app serves `ci.functions()` and sets itself up. In a terminal it shows what it found and asks you to confirm:

```
  CI      ci/client.ts (ci)
  Server  server.ts
  Start   pnpm run start
  Path    /api/inngest

  Run inngest-ci with this?
› Yes
  Use another server
  Edit the start command and path
```

It writes the `ci` key of `inngest.json`, offers to add `.inngest/` to `.gitignore`, and carries straight on with your run. If a later run can't start your app, it shows why and offers to run setup again. Nothing in your code is run to find any of this. See [Configure](#configure) to edit it by hand.

Without a terminal, such as for an agent, a missing config is a setup error that says what was found and prints the `inngest.json` to write.

It starts a Dev Server and your app, and stops both when you quit. In a terminal it draws the runs live:

```
inngest-ci pr  pull_request.opened · jack/ci-package @ 70f798f + uncommitted
Dev Server  http://127.0.0.1:24288   app  port 41711
◐ pr                                   1m 12s
├─ ✓ base   restored from cache        0.8s
├─ ✓ lint   pnpm lint                  22s
└─ ◐ test   creating machine…          41s
```

While no command runs, a job shows what it is doing, like `creating machine…` or `uploading working tree (12 MB)…`.

| Key | Does |
| --- | --- |
| `↑` `↓` | Moves the highlight across runs and jobs. |
| `enter` | Opens the highlighted run's trace in your browser. On WSL it uses `wslview`, or `explorer.exe`. If nothing opens, the footer shows the URL. |
| `q`, `Ctrl-C` | While running, cancels the runs, cleans up, and exits. |

When every run has ended, the Dev Server and app stay up so the traces still open. `q` cleans up and exits. After a picker session, `r` goes back to the picker with no restart.

Pass `--no-interactive` to print one line per transition instead. This is also the default without a terminal, such as in a log or for an agent. It ends with `inngest-ci open <runId>` for each run.

### Pick what to run

Run `inngest-ci` with no target in a terminal to pick from your pipelines, jobs and matrices.

| Key | Does |
| --- | --- |
| `↑` `↓` | Moves. |
| `space` | Selects. On a matrix, an axis or a value, it selects everything under it. |
| `→` `←` | Opens and closes a matrix and its axes. |
| `enter` | Runs the selection in parallel, or the highlighted row if nothing is selected. |
| `q`, `esc` | Quits. |

A matrix is a tree of its axes and their values. `●` is all selected, `◐` some and `○` none.

```
  ◐ compat   2/4 combinations
    ◐ os: *
      ● linux
      ○ mac
    ● node: *
      ● 20
      ● 22
```

The count is the selected combinations out of those the matrix runs, so `exclude` and `include` count. A combination is selected when every value in it is.

Without a terminal, no target is an error that lists what you can run.

### Run one job

A target that names a job runs only that job.

```bash
npx inngest-ci test
npx inngest-ci build --input '{"target":"web"}'
npx inngest-ci compat --node 22
npx inngest-ci compat --node 20 --node 22 --os linux
```

- `--input` is the job's input, as JSON.
- A matrix takes `--<axis> <value>` to limit it. Repeat an axis for several values: the last command runs the combinations with node 20 or 22 on linux. With no axis flags, it runs every combination.
- If a name is both a pipeline and a job, pass `--pipeline <name>` or `--job <name>`.

### Choose the event

A pipeline runs on an event built from your current checkout. For a pipeline with several triggers, `--event` picks one. Without a terminal, `--event` is required. In a terminal, it asks.

```bash
npx inngest-ci release --event push
npx inngest-ci deploy --data '{"env":"preview"}'
```

`--data` is the `event.data` for a [`ci.manual()`](#triggers) trigger, or `{"body": "..."}` for a comment trigger. Given a schema, `--data` and `--input` are checked against it, and a mismatch lists the fields it wants.

### Input forms

In a terminal, a target that needs data asks for it: a trigger, a comment's text, the data of a `ci.manual({ schema })` trigger, or the input of a job with an [`input` schema](#jobs). The data is asked field by field, from the schema, so you never face a blank line.

```
  deploy · event data

  ✓ target  api

  dryRun  2 of 3 · optional · default yes
  Build and check without releasing
› yes  default
  no
  leave out

  ↑↓ move · enter pick · esc cancel
```

- Each field shows its description, its default and whether it is required. `enter` accepts the default, and on an empty optional field leaves it out.
- Objects are asked a property at a time, with nested ones by path, like `build.target`.
- A string with an `enum`, or a union of literals, is a list. A boolean is yes or no. A number is checked against its `min` and `max`. A list of strings or numbers takes one item at a time, and an empty entry finishes it.
- Anything else, such as a union of objects or a record, is a line of JSON for that field, starting from an example.
- A mistake shows under the field, which stays until it is right.
- At the end, the form shows the finished JSON. Choose Run, Edit a field or Start over.

The form is built from the schema's JSON Schema, which `inngest-ci` takes from any library that can write one, such as Zod 4. A schema it can't read, such as Valibot's, gets a JSON line with a note saying so. A job that takes input but has no `input` schema says to add one.

After a run with typed data, it offers to save it as a fixture. Fixtures are files in `<dir>/fixtures/<target>/<name>.json`. The next time, the prompt offers each one to use as it is, or to start from, which fills the form with its values. New starts with a blank form.

```bash
npx inngest-ci deploy --fixture nightly-api
```

`--fixture` uses a saved input without asking. A flag still wins over the fixture for the same field.

### Open an earlier run

```bash
npx inngest-ci open            # the latest run
npx inngest-ci open 01KABC...  # a run by ID
```

Each session keeps its runs in its own Dev Server database, `<dir>/dev-server/<session>`, so sessions can run side by side. `open` finds the session that ran the run (or the latest session), starts a Dev Server on its database without your app, opens the run in your browser and prints its URL. It stays up until `Ctrl-C`. Databases are cleaned up with their session's state file, some time after it ends. A job or pipeline named `open` is reached with `--job open`.

### Flags

| Flag | Does |
| --- | --- |
| `--pipeline <id>` | Runs the pipeline with this ID. |
| `--job <id>` | Runs the job with this ID. |
| `--event <name>` | Picks a trigger when the pipeline has several. |
| `--data <json>` | Sets `event.data` for a `ci.manual()` or comment trigger. |
| `--input <json>` | Sets a job's input. |
| `--fixture <name>` | Uses a saved input. |
| `--<axis> <value>` | Limits a matrix to a value of an axis. Repeat it for several. |
| `--no-interactive` | Prints plain lines instead of the live view. |
| `--help` | Prints usage. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The run passed. |
| `1` | The run failed or was cancelled. |
| `2` | Setup failed, such as a missing config, an unknown target, or a Dev Server that did not start. |

Setup errors say what to change.

Each session also writes its live state to `~/.local/state/inngest-ci/sessions` (or `$INNGEST_CI_STATE_DIR`) for editor integrations.

### Configure

`inngest-ci` reads the `ci` key of `inngest.json` at the repository root.

```json
{
  "ci": {
    "start": "tsx server.ts",
    "path": "/api/inngest",
    "dir": ".inngest/ci",
    "devServer": { "bin": "/path/to/inngest" }
  }
}
```

| Key | Default | Does |
| --- | --- | --- |
| `start` | | The shell command that serves your app. It must listen on `PORT`. |
| `path` | `/api/inngest` | Where your app serves Inngest. |
| `dir` | `.inngest/ci` | Where runs keep their files, relative to the repository root. |
| `devServer.bin` | | The path to a Dev Server binary. |

`inngest-ci` writes this for you the first time. Edit it by hand to change the start command or path, to move `dir`, or to point at a Dev Server binary. Setup keeps every other key.

With no `ci` key, `inngest-ci` looks for `ci/server.ts`, `ci/server.mts`, `ci/server.js`, or `ci/server.mjs` and starts it with `tsx` or `node`. If there is none, it runs setup.

- Your app starts with `PORT` and `INNGEST_DEV=1` set. `ci.functions()` must be in what it serves. [`ci.local`](#local-runs) is `true`.
- Add `.inngest/` to `.gitignore`; setup offers to. It holds the Dev Server's data, saved fixtures and the logs in `logs/dev-server.log` and `logs/app.log`.

### The Dev Server

`inngest-ci` uses the first of these:

1. The binary at `INNGEST_CI_DEV_SERVER_BIN`.
2. The binary at `ci.devServer.bin`.
3. The `inngest-cli` package in your project, version 1.45.1 or newer.
4. `inngest-cli`, then `inngest`, on your `PATH` (a global install), at the same minimum version.

```bash
npm install --save-dev inngest-cli
```

It starts the Dev Server on free ports and stops it when you quit. Each session's database in `<dir>/dev-server/<session>` keeps its run history after it ends.

### Send an event yourself

`fixtures` builds the same events `inngest-ci` sends. Use it to send one from your own script.

```ts
import { fixtures } from "@inngest/ci";
import { inngest } from "./ci/client";

await inngest.send(await fixtures.pullRequest());
```

`fixtures.push()` and `fixtures.comment()` build the other GitHub events.

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
- `repo` (`"owner/name"`) gives crons and manual runs a repository. The run resolves its default branch and head commit in a step before the handler starts, so `checkout()`, GitHub helpers, checks, and cache keys work. It needs GitHub credentials, so with the console reporter the repository has no commit.
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
- `comment({ minPermission })` checks the author after the run starts, against the command the comment starts with. A user without the permission gets a reply and a neutral check.
- Several triggers give a union type. Narrow it with `"pull_request" in event.data`.
- A cron has no typed `event.data`. `ci.manual({ schema })` types it from any Standard Schema validator, such as Zod, and `inngest-ci` asks for its fields in a [form](#input-forms).

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
| `input` | Any Standard Schema | No |

`input` validates what the job is called with, and types it. The handler gets the schema's output, defaults applied. A call that doesn't match throws a `CiUsageError` that lists each issue's path and message. `inngest-ci` asks for the input in a [form](#input-forms).

```ts
const build = ci.job(
  {
    id: "build",
    input: z.object({
      target: z.enum(["web", "api"]),
      minify: z.boolean().default(true),
    }),
  },
  async ({ target, minify }) => {
    await $`pnpm build --target ${target} ${minify ? "--minify" : ""}`;
  },
);

await build({ target: "web" });
```

`keepOnFailure` snapshots the machine when the job fails. The snapshot ID appears on the job check and in the pipeline summary. The duration is currently ignored: the snapshot is kept for the platform's default retention.

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
| `.text()`, `.lines()`, `.json()` | Returns stdout as a trimmed string, an array of lines, or parsed JSON. |

- `$` runs without a shell. `$.sh` runs `/bin/sh -c` and escapes interpolated values.
- A result holds `exitCode`, `stdout`, `stderr`, `truncated`, and `durationMs`. `stdout` and `stderr` keep the last 64 KiB. `durationMs` is missing when the Sandbox API doesn't time the command, which today is any command with a timeout of 5 minutes or less.
- `$` outside a job throws `CiUsageError`.
- `.background()` returns once the process starts. `kill()` sends `SIGTERM` unless you pass a signal number, `output()` reads the last 64 KiB by default, and `exited()` polls for exit. It ignores `.retries()`, `.timeout()`, and `.nothrow()`.
- Output arrives when the command ends. A `.timeout()` of 5 minutes or less is exact. A longer one is approximate because Inngest polls for exit.

> [!NOTE]
> Running a command with a secret isn't supported yet. `.withSecret()` is deprecated and throws `CiUsageError`, because the Sandbox API has no per-command secrets and command environment is persisted in step data.

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
- `failFast` is off by default. When it is on, the first failure ends the matrix: combinations that have not started never start, and running ones are not cancelled.
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
- A job's input is part of its cache identity, so the same key with a different input is a separate entry.

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
| Reused from cache | Success, with `Cached …` or `Passed at <sha>, no changes since` |
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

### Local runs

`ci.local` is `true` in a run started by [`inngest-ci`](#run-locally). Use it to skip work that must not happen from a laptop.

```ts
export const release = ci.pipeline(
  { id: "release", on: github.push({ branches: ["main"] }) },
  async () => {
    await test();

    if (ci.local) {
      return ci.skip("not publishing from a local run");
    }

    await publish();
  },
);
```

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

## Run metadata

Every pipeline run is tagged with `userland.inngest-ci` metadata, visible on the run in Inngest. It tells Inngest the run is a CI run and which parts of `@inngest/ci` it used. It's sent with steps CI already runs, so it adds nothing to the trace.

When the run starts:

```json
{
  "package": "@inngest/ci",
  "version": "0.1.0",
  "local": false,
  "repo": "inngest/inngest-js",
  "ref": "feature",
  "sha": "abc1234",
  "pullRequest": 7
}
```

`repo`, `ref`, `sha` and `pullRequest` identify your repository, branch, commit and pull request, and are left out when the run has none. The pipeline, its trigger and the run's duration aren't repeated here: they're already on the run.

When the run ends:

```json
{
  "conclusion": "success",
  "jobs": { "total": 3, "passed": 2, "failed": 0, "cached": 1, "skipped": 0, "cancelled": 0 },
  "apis": { "from": 1, "matrix": 1, "cache": 1, "commands": 6, "githubRest": 0 }
}
```

`apis` counts calls in the run to `from`, `matrix`, `cache`, `sandbox`, `checkout`, `changed`, `report`, `waitFor`, `waitForChecks`, `waitForWorkflow`, `commands`, `background`, `shard`, `skip`, `githubRest` and `githubHelpers`. Job and check steps carry a small `{ job, kind }` tag too. Commands, output, and secrets are never recorded.

## Next steps

- [Sandboxes](https://www.inngest.com/docs/sandboxes/overview): the microVMs that run every job, with limits and snapshots.
- [Durable execution](https://www.inngest.com/docs/durable-execution): how Inngest saves steps, retries failed work, and resumes runs.
- [Flow control](https://www.inngest.com/docs/durable-execution/flow-control/concurrency): concurrency, throttling, debounce, and the other options a pipeline accepts.
- [`examples/ci-pipelines`](https://github.com/inngest/inngest-js/tree/main/examples/ci-pipelines): a runnable example with pipelines, matrices, caching, and GitHub checks.
- [Dev Server](https://www.inngest.com/docs/dev-server): run pipelines locally and inspect traces.
