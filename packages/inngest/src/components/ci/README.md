# Inngest CI

Inngest CI lets you write CI in TypeScript. A **pipeline** runs when something happens and calls your **jobs**. **Each job gets its own machine** when it runs its first **command**.

Every job is durable. It's retried if it fails, remembered once it succeeds, and shown in the trace as it runs. Every pipeline reports its results back to GitHub as checks.

> **Experimental.** Inngest CI is an early prototype. APIs marked deprecated in your editor are typed placeholders for features the platform doesn't support yet, and everything here can change without a major version bump.
>
> **Machines don't run locally yet.** Everything that doesn't need one — pipelines, jobs, checks, caching, `github.rest`, `changed()` — works against the Dev Server today. Commands need the sandbox API. See [Running locally](#running-locally).

These are the user-facing docs. Alongside them:

| File | What it's for |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | How CI maps onto the SDK's primitives, for working on it |
| [NOTES.md](./NOTES.md) | What was verified, every deviation, and what would remove it |
| [REPORT.md](./REPORT.md) | What works, what's stubbed, and the open questions |
| [`examples/ci-pipelines`](../../../../../examples/ci-pipelines) | A runnable project with all of this in it |

## How the files fit together

The examples keep each kind of code in its own file, so the pipeline reads as the plan:

```
ci/
├─ client.ts      your Inngest client and CI setup
├─ helpers.ts     plain functions
├─ jobs.ts        ci.job and ci.matrix
└─ pipelines.ts   ci.pipeline
```

## Setup

### 1. Install

```bash
npm install inngest
```

Inngest CI ships in the `inngest` package as `inngest/ci`.

> While it's a prototype in this repository, build the package and point your project at it:
>
> ```bash
> cd packages/inngest && pnpm build
> cd your-project && pnpm add inngest@link:../inngest-js/packages/inngest/dist
> ```

### 2. Create the CI client

```ts
// ci/client.ts
import { Inngest } from "inngest";
import { createCi, githubApp } from "inngest/ci";

export const inngest = new Inngest({ id: "ci" });

export const ci = createCi(inngest, {
  github: githubApp({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  }),
});
```

### 3. Serve your pipelines

`ci.functions()` returns your pipelines plus the few functions Inngest CI needs behind the scenes, like cleanup and cache refreshes.

```ts
// app/api/inngest/route.ts
import { serve } from "inngest/next";
import { inngest, ci } from "@/ci/client";
import "@/ci/pipelines";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: ci.functions(),
});
```

### 4. Connect GitHub

1. **Create a GitHub App** for your organization with these permissions:
   - Checks: read and write
   - Commit statuses: read and write
   - Contents: read
   - Pull requests: read and write
   - Issues: read and write
   - Metadata: read
2. **Subscribe it to events:** push, pull request, check run, check suite, issue comment, and merge group.
3. **Point its webhook at Inngest.** Create a webhook in the Inngest dashboard, paste the transform from `githubWebhookTransform`, and use that webhook's URL.
4. **Install the app** on the repositories you want to run CI for.
5. **Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`** in your app's environment.

GitHub events now arrive as Inngest events like `github/pull_request.opened`, and your pipelines can report checks.

## Pipeline

A pipeline runs when something happens, and calls your jobs.

```ts
// ci/pipelines.ts
import { github } from "inngest/ci";
import { ci } from "./client";
import { test, deploy } from "./jobs";

export const pr = ci.pipeline(
  { id: "pr", on: github.pullRequest() },
  async () => {
    await test();
    await deploy();
  },
);
```

A pipeline is plain async code, so `if`, loops, and `Promise.all` all work.

## Trigger

A trigger is the event that starts a pipeline.

```ts
on: github.pullRequest({ branches: ["main"] })
on: github.push({ branches: ["main"], tags: ["v*"] })
on: github.comment({ command: "/prerelease", minPermission: "write" })
on: github.mergeGroup()
on: github.checkSuite({ branch: "main" })
on: { cron: "0 3 * * *" }
on: ci.manual({ schema })
```

Pass an array to start a pipeline from several triggers.

**The trigger types the event.** A pipeline's handler knows what it's holding, with no schema and no cast:

```ts
ci.pipeline({ id: "pr", on: github.pullRequest() }, async ({ event }) => {
  event.data.pull_request.head.sha;  // string
  event.data.action;                 // "opened" | "synchronize" | "reopened"
});
```

- **`types` narrows it.** `github.pullRequest({ types: ["closed"] })` gives an event with `pull_request.merged` on it; the default three don't have that.
- **Several triggers give a union**, which you narrow in the handler:

  ```ts
  ci.pipeline(
    { id: "both", on: [github.pullRequest(), github.push()] },
    async ({ event }) => {
      const sha = "pull_request" in event.data
        ? event.data.pull_request.head.sha
        : event.data.after;
    },
  );
  ```

- **A cron has no payload of its own**, so its `event.data` is an open record.
- **`ci.manual({ schema })` uses your schema**, so `event.data` is whatever it describes.

The handler also gets `runId`, `pipelineId`, `attempt`, `logger`, `events` for batches, and `repo`: the owner, name, and commit this run is for, or `undefined` for a trigger that doesn't carry one.

## Job

**Each job gets its own machine.** A job is a unit of work, like test, deploy, or e2e. Its machine starts when it runs its first command, and it's destroyed when the pipeline finishes.

```ts
// ci/jobs.ts
import { checkout, $ } from "inngest/ci";
import { ci } from "./client";

export const test = ci.job("test", async () => {
  await checkout();       // machine starts here
  await $`pnpm install`;
  await $`pnpm test`;
});

export const deploy = ci.job("deploy", async () => {
  return vercel.deploy({ token: process.env.VERCEL_TOKEN });  // no commands, no machine
});
```

Call a job like a function. Jobs can return values, and two jobs never share a machine.

The first argument is the job's ID. When you need more options, pass an object instead:

```ts
ci.job("test", fn)
ci.job({ id: "build", machine: { vcpu: 4 } }, fn)
```

**A job runs once per pipeline run.** If two parts of a pipeline call `test()`, they both wait on the same run.

## Command

A command runs a shell command on the job's machine.

```ts
await $`pnpm test`;
```

Values you interpolate are passed as arguments, so there's nothing to quote:

```ts
await $`pnpm --filter ${pkg} test`;
```

Arrays spread into several arguments, and `null`, `undefined`, and `false` are dropped, so a conditional flag is one expression:

```ts
await $`pnpm test ${bail && ["--bail", "1"]}`;
```

A command that exits with a non-zero code fails the job. Commands have a few options, and they chain:

```ts
await $`pnpm test`.retries(2);                  // allow retries for a flaky command
await $`pnpm lint`.nothrow();                   // return the exit code instead of failing
await $`pnpm test`.env({ CI: "true" });         // set environment variables
await $`pnpm test`.cwd("/work/app");            // run somewhere else
await $`pnpm test`.timeout("10m");              // give up after this long
await $`pnpm test`.onTimeout(() => $`ps auxf`); // look around before it's killed
await $`pnpm start`.background();               // keep running while the job continues
await $`pnpm exec playwright test`.as("e2e");   // name it in the trace

const sha = await $`git rev-parse HEAD`.text(); // stdout, trimmed
const files = await $`git ls-files`.lines();    // stdout, split
const meta = await $`cat package.json`.json<{ name: string }>();
```

For pipes, redirects, or `&&`, use `$.sh`:

```ts
await $.sh`pnpm build && pnpm test | tee test.log`;
```

Calling `$` outside a job throws an error, because there's no machine to run it on.

## Machine

**One machine per job.** It's created the first time the job runs a command, and destroyed when the pipeline finishes.

A job that never runs a command never gets a machine. A job that waits before its first command, like one waiting for approval, doesn't pay for a machine while it waits.

### Your code runs in your app, commands run on the machine

Everything in a job except `$` runs in your app. Only commands are sent to the machine, so a secret only reaches the machine if you pass it to a command:

```ts
await $`pnpm publish`.withSecret("NPM_TOKEN", token);
```

> **Not isolated yet.** `withSecret` keeps the value out of step input, step output, and check output — it's passed from inside the step handler and masked in results — but it's an ordinary environment variable on the machine, so code running there can read it.

## Helpers

A helper is a regular function that runs commands. It runs on the machine of whichever job calls it.

```ts
// ci/helpers.ts
import { checkout, $ } from "inngest/ci";

export async function install() {
  await checkout();
  await $`pnpm install --frozen-lockfile`;
}
```

```ts
// ci/jobs.ts
import { $ } from "inngest/ci";
import { ci } from "./client";
import { install } from "./helpers";

export const test = ci.job("test", async () => {
  await install();
  await $`pnpm test`;
});
```

Helpers need nothing special. Share them between jobs, publish them as a package, or call them from a script.

## Steps inside a job

A job is durable the same way an Inngest function is. Each command is a step, so it never runs twice. Other code in the job reruns whenever the job resumes, which is fine for reading data and making decisions.

For anything with side effects, like creating resources, calling APIs, or posting comments, use `step.run` so it happens exactly once:

```ts
// ci/jobs.ts
import { step } from "inngest";
import { checkout, $ } from "inngest/ci";
import { ci } from "./client";

export const migrations = ci.job("migrations", async () => {
  const db = await step.run("create-db-branch", () =>
    neon.branches.create({ parent: "main" }));

  try {
    await checkout();
    await $`pnpm install`;
    await $`pnpm db:migrate`.env({ DATABASE_URL: db.url });
    await $`pnpm test:db`.env({ DATABASE_URL: db.url });
  } finally {
    await step.run("delete-db-branch", () => neon.branches.delete(db.id));
  }
});
```

If `pnpm test:db` fails and the job retries, the database branch isn't created again.

Step IDs inside a job are scoped to that job, so two jobs can both have a `create-db-branch` step.

The rest of the step API works inside jobs too. This job builds, waits for approval, then publishes from the same machine:

```ts
export const release = ci.job("release", async () => {
  await checkout();
  await $`pnpm install`;
  await $`pnpm build`;

  const approval = await step.waitForEvent("approval", {
    event: "release/approved",
    timeout: "24h",
  });
  if (!approval) return;

  const token = await step.run("npm-token", () => npm.exchangeOidcToken());
  await $`pnpm publish --no-git-checks`.withSecret("NPM_TOKEN", token);
});
```

While it waits, the machine is paused, so nothing is billed.

## Calling other services

Jobs are TypeScript, so call other services with the SDKs you already use. Put calls with side effects in `step.run`, so they happen exactly once even if the job retries.

```ts
// ci/jobs.ts
import { step } from "inngest";
import Stripe from "stripe";
import { ci } from "./client";

const stripe = new Stripe(process.env.STRIPE_KEY);

export const billingSmokeTest = ci.job("billing-smoke-test", async () => {
  await step.run("create-and-delete-customer", async () => {
    const customer = await stripe.customers.create({ email: "ci@example.com" });
    await stripe.customers.del(customer.id);
  });
});
```

When a service rate-limits you, throw `RetryAfterError`. Inngest schedules the retry for later, so nothing sits waiting in the meantime:

```ts
import { RetryAfterError, step } from "inngest";

await step.run("sync-customers", async () => {
  try {
    return await stripe.customers.list({ limit: 100 });
  } catch (err) {
    if (err.statusCode === 429) throw new RetryAfterError("Rate limited", "30s");
    throw err;
  }
});
```

## GitHub

`github` has two parts:

- **`github.rest`** is all of GitHub's REST API, through [Octokit](https://github.com/octokit/octokit.js), GitHub's official SDK. Each call is a step.
- **Helpers** like `github.stickyComment()` handle things CI needs that take several calls or a wait.

### `github.rest`

Every Octokit REST method, with the same names and types:

```ts
// ci/jobs.ts
import { github } from "inngest/ci";
import { ci } from "./client";

export const release = ci.job("release", async () => {
  const release = await github.rest.repos.createRelease({ tag_name: "v1.4.0", generate_release_notes: true });
  await github.rest.git.updateRef({ ref: "heads/next", sha: github.repo().sha, force: true });
  return release.html_url;
});
```

```
release
├─ github › repos.createRelease   201, 180ms
└─ github › git.updateRef         200, 95ms
```

- **Each call is a step,** retried if it fails, remembered once it succeeds, and shown in the trace.
- **`owner` and `repo` default** to the repository that triggered the pipeline.
- **Methods return `data`,** not the full response.
- **Authentication is handled** with your GitHub App.
- **Rate limits are handled.** A rate-limited call is retried when GitHub's limit resets.

Where you call `github.rest` decides how it runs:

| Called from | Behaviour |
|---|---|
| A job or pipeline | Each call is its own step |
| Inside `step.run` | Runs directly as part of that step |
| A script or test, outside any pipeline | Runs directly |

Group calls in `step.run` when they belong together and should retry as one. To choose a call's step ID, use `.with()`:

```ts
await github.rest.with({ id: "tag-release" }).git.createRef({ ref: "refs/tags/v1.4.0", sha });
```

### Helpers

| Helper | What it does |
|---|---|
| `github.stickyComment(key, body)` | Creates one pull request comment, and updates it on later runs |
| `github.upsertPullRequest({ head, base, title, body })` | Opens a pull request, or updates the one that's already open |
| `github.forcePushRef(ref, sha)` | Moves a branch or tag to a commit, creating it if it doesn't exist |
| `github.canUser(login, permission)` | Checks whether a user has at least `read`, `triage`, `write`, `maintain`, or `admin` |
| `github.waitForChecks({ names, sha? })` | Waits for other checks on a commit to finish, without keeping a machine busy |
| `github.waitForWorkflow({ workflow, sha? })` | Waits for a GitHub Actions workflow run to finish |
| `github.paginate(method, params)` | Fetches every page of a list method |
| `github.graphql(query, variables)` | Runs a GraphQL query |
| `github.repo()` | Returns `owner`, `repo`, `sha`, and pull request `number` from the trigger |
| `github.token()` | A short-lived token for the `gh` CLI or `fetch`. Call it inside `step.run` |
| `github.octokit()` | A plain Octokit client, for streams and anything else. Call it inside `step.run` |

```ts
await github.stickyComment("preview", `Preview: ${preview.url}`);
```

### Helpers are ordinary code

Each helper is a `step.run` that uses `github.rest` inside it, so you could write any of them yourself. If one doesn't quite fit, copy it and change it:

```ts
import { step } from "inngest";
import { github } from "inngest/ci";

export async function stickyComment(key: string, body: string) {
  return step.run(`sticky-comment-${key}`, async () => {
    const { number } = github.repo();
    const marker = `<!-- ${key} -->`;
    const text = `${marker}\n${body}`;

    const comments = await github.paginate(github.rest.issues.listComments, { issue_number: number });
    const existing = comments.find((c) => c.body?.includes(marker));

    return existing
      ? github.rest.issues.updateComment({ comment_id: existing.id, body: text })
      : github.rest.issues.createComment({ issue_number: number, body: text });
  });
}
```

### Things to know

- **Results are stored as JSON,** and typed that way: a method returns its response's `data`, so dates are strings. Keep results small, since they count towards step output limits.
- **Streaming methods,** like `paginate.iterator`, aren't available on `github.rest`. Use `github.octokit()` inside `step.run`.
- **`github.token()` and `github.octokit()` must be called inside `step.run`.** They throw otherwise, because a token in a step's input or output would show in the trace.
- **A create call can occasionally run twice** if a worker disappears right after the call succeeds. The helpers guard against this where it matters, like `stickyComment` finding its existing comment.
- **`github.paginate` infers its item type** from the method you hand it, so `comments[0].body` is typed without saying what it is.

## Durability

Say the deploy provider has an outage partway through this pipeline:

```ts
async () => {
  await test();     // passes
  await deploy();   // fails, provider returns 503
  await e2e();      // waits
}
```

1. **`deploy` is retried** automatically, with backoff.
2. **`test` doesn't run again.** It already succeeded, so its result is remembered.
3. **When `deploy` succeeds, the pipeline carries on** to `e2e`.

The same holds inside a job. If `pnpm test` fails, `checkout` and `pnpm install` are remembered, so you can rerun from `pnpm test`. If a machine disappears mid-command, the command is retried.

## Starting from another job's machine

**`from()` starts a job on a copy of another job's machine.** Install once, then run lint and test from that point:

```ts
// ci/jobs.ts
import { checkout, from, $ } from "inngest/ci";
import { ci } from "./client";

export const setup = ci.job("setup", async () => {
  await checkout();
  await $`pnpm install`;
});

export const lint = ci.job("lint", async () => {
  await from(setup);
  await $`pnpm lint`;
});

export const test = ci.job("test", async () => {
  await from(setup);
  await $`pnpm test`;
});
```

```ts
// ci/pipelines.ts
import { github } from "inngest/ci";
import { ci } from "./client";
import { lint, test } from "./jobs";

export const pr = ci.pipeline(
  { id: "pr", on: github.pullRequest() },
  async () => {
    await Promise.all([lint(), test()]);
  },
);
```

```
pr
├─ setup   machine
├─ lint    copy of setup
└─ test    copy of setup
```

`setup` runs once, even though both jobs start from it. `lint` and `test` skip checkout and install, and they can't affect each other.

`from()` returns whatever the parent job returned, and because it's code, the starting point can be decided at runtime:

```ts
export const docs = ci.job("docs", async () => {
  await from((await changed("docs/**")) ? docsSetup : setup);
  await $`pnpm docs:build`;
});
```

**Calling a job versus starting from it**

- **`await setup()`** runs setup on its own machine and returns its result.
- **`await from(setup)`** makes sure setup has run, then starts this job's machine as a copy of where setup finished.

`from()` must come before the job's first command, and a job can only start from one place.

## Running a job with different inputs

Wrap a job in a function to make one per input, and call it inside the function so callers don't have to:

```ts
// ci/jobs.ts
export const compat = (node: string) =>
  ci.job(`compat (node:${node})`, async () => {
    await checkout();
    await $`fnm use ${node}`;
    await $`pnpm install`;
    await $`pnpm test`;
  })();
```

```ts
// ci/pipelines.ts
await Promise.all(["20", "22", "24"].map(compat));
```

```
pr
├─ compat (node:20)
├─ compat (node:22)
└─ compat (node:24)
```

Each run is durable on its own. If `compat (node:22)` fails, only that run is retried. Because the ID comes from the input rather than the order of calls, adding or skipping a version never affects the others.

## Matrices

For more than one input, use `ci.matrix`. It runs every combination:

```ts
// ci/jobs.ts
export const compat = ci.matrix(
  {
    id: "compat",
    axes: { node: ["20", "22", "24"], db: ["sqlite", "postgres"] },
    exclude: [{ node: "20", db: "postgres" }],
  },
  async ({ node, db }) => {
    await from(setup);
    await $`pnpm test`.env({ NODE_VERSION: node, TEST_DATABASE: db });
  },
);
```

```ts
// ci/pipelines.ts
await compat();                               // every combination, in parallel
await compat({ node: "22", db: "postgres" }); // just one
```

A matrix also lets you set:

- **`concurrency`:** how many combinations run at once.
- **`failFast`:** stop the rest when one fails. It's off by default, so you see every result.

Use a wrapping function for one input, and `ci.matrix` for two or more, exclusions, or limits.

## Caching

**A job can reuse its last result when nothing it depends on has changed.**

```ts
// ci/jobs.ts
import { checkout, files, $ } from "inngest/ci";
import { ci } from "./client";

export const setup = ci.job(
  {
    id: "setup",
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

- **`key`:** if nothing in the key changed since the last successful run, the job is reused. No machine starts, and `from(setup)` starts from the saved machine.
- **`refresh`:** triggers that rebuild the cache ahead of time, like a nightly cron or an event, so pull requests don't pay for it.

Keys are code, so you can combine files and values:

```ts
key: files("pnpm-lock.yaml")
key: files("migrations/**", "seeds/**")
key: [files("go.mod", "go.sum"), "go1.25"]
```

**Chains update themselves.** A job that starts `from(setup)` includes setup's cache in its own key. If `pnpm-lock.yaml` changes, setup rebuilds and so does everything built from it.

> `from()` is called inside the handler, so a job only knows what it started from once it has run. Its entry records that, and the parents' keys are folded into its own from then on. The consequence: the very first run of a new job can't know its parents at lookup time, so it's a miss — which is what you want anyway.

A job that doesn't produce anything to restore, like `test`, can use a cache too. When nothing changed, it's reused and shows as passed:

```
pr
├─ setup   restored, built 5h ago by the nightly refresh
├─ lint    copy of setup
└─ test    passed at a3f91c2, no changes since
```

> "Cache" is a slightly odd name for jobs like `test`, where nothing is restored and the job simply doesn't need to run again. The trace and GitHub checks say what happened in plain terms: "restored" or "passed at …".

Only use caching for tests that don't depend on the network or other outside state.

## Extra machines

A job's commands run on its own machine. When work needs another machine at the same time, create it with `sandbox()`:

```ts
// ci/jobs.ts
import { checkout, sandbox, waitForHttp, $ } from "inngest/ci";
import { ci } from "./client";

export const e2e = ci.job("e2e", async () => {
  const api = await sandbox("api");
  await api.$`pnpm start`.background();
  await api.waitForPort(3000);

  await checkout();
  await $`pnpm install`;
  await $`pnpm exec playwright test`;
});
```

`$` on its own still means the job's machine. Extra machines are destroyed with the pipeline and appear under the job in the trace.

> **Machines can't reach each other yet**, so `api.url(3000)` throws `CiNotSupportedError`. Until they can, run the server on the job's own machine and talk to `127.0.0.1`:
>
> ```ts
> await $`pnpm start`.background();
> await waitForPort(3000);
> await $`pnpm exec playwright test`.env({ API_URL: "http://127.0.0.1:3000" });
> ```

| If the work... | Use |
|---|---|
| Is independent, like lint and test | separate jobs |
| Follows on from earlier work, like install then test | separate jobs, using `from()` |
| Needs several machines alive and talking | one job, with `sandbox()` for the others |

## Checks on pull requests

**Every pipeline reports to GitHub automatically.** You don't write any status code.

- **One check for the pipeline**, named after its ID. This is the one to make required in branch protection.
- **One check per job**, so you can see which part failed. Job checks are informational.

```
✕ pr                   test failed
✓ pr / setup           restored, built 5h ago
✓ pr / lint            passed in 22s
✕ pr / test            pnpm test exited with 1
```

| What happened | Check shows |
|---|---|
| Job is running | In progress, with the current command |
| Job is retrying | In progress, "Attempt 2 of 3" and why the last one failed |
| Job passed | Success, with its duration |
| Job reused from cache | Success, "Passed at a3f91c2, no changes since" |
| Job failed | Failure, with the failing command, the end of its output, and annotations |
| Later jobs never started because one failed | No job check. The pipeline check names the job that failed |
| Jobs still running when one of them failed | Cancelled, "Cancelled: the pipeline ended first" |
| A new push replaced the run | Cancelled, "Superseded by b41e9d0" |
| Pipeline returned early, like when nothing relevant changed | Success, with the reason |

Every check links to the run's trace in Inngest, and **Re-run** on a check re-runs the pipeline.

> **Re-run starts from the beginning**, not from the job that failed: the REST API can't yet rerun from a step. `rerunFromFailedJob` is typed and throws until it can. Cached jobs are restored rather than rebuilt, so a re-run usually picks up close to where it left off anyway.

### Why this avoids common check problems

- **Required checks never get stuck waiting.** The pipeline check always reports, even when the pipeline decides there's nothing to do.
- **Matrices don't break branch protection.** Require the pipeline check, and job checks can come and go.
- **Old pushes don't leave checks spinning.** Superseded runs are marked cancelled.
- **Fork pull requests get checks too,** because checks are written by your GitHub App.

### Adding to a check

Inside a job, add to that job's check:

```ts
import { report } from "inngest/ci";

await report.summary(`Coverage: **${coverage}%**`);
await report.annotate([{ path: "src/queue.ts", line: 42, message: "Flaky retry here" }]);
```

Summaries are truncated at GitHub's 65,000 characters, with a pointer to the trace, and annotations go up in batches of 50, which is GitHub's limit per request.

To rename checks, or turn them off for a job:

```ts
ci.pipeline({ id: "pr", on: github.pullRequest(), check: { name: "CI" } }, fn)
ci.job({ id: "notify", check: false }, fn)
```

## Controlling when pipelines run

A pipeline takes all of Inngest's flow control options. Three of them solve problems most teams hit on day one:

```ts
// ci/pipelines.ts
export const pr = ci.pipeline(
  {
    id: "pr",
    on: [github.pullRequest(), github.push()],

    // A new push to the same PR cancels the run already in progress
    singleton: { key: "event.data.pull_request.number", mode: "cancel" },

    // push and pull_request both fire for the same commit: run it once
    idempotency: "event.data.sha",

    // At most 20 machines at a time across your whole org
    concurrency: {
      key: "event.data.repository.owner.login",
      limit: 20,
      scope: "account",
    },
  },
  async () => { /* ... */ },
);
```

There's more in the flow control guide: prioritising `main` over PR checks, throttling bot PRs, debouncing rebuilds, rate-limiting slash commands, and building a merge queue with batched events.

## Running locally

Run and debug pipelines on your machine with the Inngest Dev Server.

```bash
npx inngest-cli@latest dev
```

> **Machines aren't local yet.** Pipelines, jobs, checks, caching, `changed()`, and `github.rest` all run against the Dev Server today; commands need the sandbox API, so a job stops at its first `$`. A job with no commands — one calling an SDK inside `step.run`, say — runs end to end.

**Send a pull request event built from your local repo.** `checkout()` uses your working tree, including uncommitted changes, so there's no need to push:

```bash
pnpm ci:send pr --event pull_request.opened
```

**Checks print to your terminal** instead of GitHub:

```
[pr] ✓ setup      restored
[pr] ✕ test       pnpm test exited with 1
[pr]   → http://localhost:8288/run?runID=01J…
```

**To post real checks from local runs**, set `INNGEST_CI_GITHUB=live` along with your GitHub App credentials, and send events for a real commit.

**To receive real GitHub webhooks locally**, forward them to the Dev Server with the example project's forwarder, using a tool like `gh webhook forward` or smee.io.

## Putting it together

**`ci/client.ts`**

```ts
import { Inngest } from "inngest";
import { createCi, githubApp } from "inngest/ci";

export const inngest = new Inngest({ id: "ci" });

export const ci = createCi(inngest, {
  github: githubApp({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  }),
});
```

**`ci/jobs.ts`**

```ts
import { checkout, files, from, $ } from "inngest/ci";
import { ci } from "./client";

export const setup = ci.job(
  { id: "setup", cache: { key: files("pnpm-lock.yaml"), refresh: [{ cron: "0 3 * * *" }] } },
  async () => {
    await checkout();
    await $`pnpm install`;
  },
);

export const lint = ci.job("lint", async () => {
  await from(setup);
  await $`pnpm lint`;
});

export const test = ci.job("test", async () => {
  await from(setup);
  await $`pnpm test`;
});

export const compat = (node: string) =>
  ci.job(`compat (node:${node})`, async () => {
    await from(setup);
    await $`fnm use ${node}`;
    await $`pnpm test`;
  })();

export const deploy = ci.job("deploy", async () => {
  return vercel.deploy({ token: process.env.VERCEL_TOKEN });
});

export const e2e = (url: string) =>
  ci.job("e2e", async () => {
    await from(setup);
    await $`pnpm exec playwright test`.env({ BASE_URL: url });
  })();
```

**`ci/pipelines.ts`**

```ts
import { github } from "inngest/ci";
import { ci } from "./client";
import { lint, test, compat, deploy, e2e } from "./jobs";

export const pr = ci.pipeline(
  {
    id: "pr",
    on: github.pullRequest(),
    singleton: { key: "event.data.pull_request.number", mode: "cancel" },
  },
  async () => {
    await Promise.all([
      lint(),
      test(),
      ...["20", "22"].map(compat),
    ]);

    const preview = await deploy();
    await e2e(preview.url);
  },
);
```

```
pr
├─ setup              restored, or a new machine
├─ lint               copy of setup
├─ test               copy of setup
├─ compat (node:20)   copy of setup
├─ compat (node:22)   copy of setup
├─ deploy             no machine
└─ e2e                copy of setup
```

When a pull request opens:

1. `setup` is restored from cache, or installs once.
2. `lint`, `test`, and each Node version start from copies of it, in parallel.
3. `deploy` runs in your app without a machine.
4. `e2e` tests the preview.
5. Each job's check updates as it goes, and the `pr` check reports the result.

A new push cancels the run and starts again. Whatever fails is retried on its own, and nothing that already passed runs twice.

> **Built on Inngest.** A pipeline is an Inngest function. A job is a group of steps with a lazily created sandbox. A command is a sandbox step. `from()` is a sandbox snapshot and clone. A matrix is a set of jobs run together. Checks are steps that call the GitHub API. `github.rest` runs each Octokit call as a step, and GitHub helpers are steps that use it. Inside any job, the full step API is available, including `step.run`, `step.waitForEvent`, and `step.sleep`.

---

# Tools for common CI annoyances

These are frustrating in most CI systems today, and usually get solved with `sleep`, bash loops, or a marketplace action. Most are one line here, because durable waits, snapshots, run history, and host-side steps already exist. Waits listen for events wherever there's something to listen to, rather than polling.

Anything marked **Not yet** is typed and throws or warns with an explanation, so you find out in your editor rather than at runtime. The full list is in [NOTES.md](./NOTES.md).

## Services and waiting

- **Wait for a port to open**
  `await waitForPort(3000)`
  Replaces `sleep 10` and `wait-on`.

- **Wait for a health check**
  `await waitForHttp("http://127.0.0.1:8288/health")`
  One retrying request on the machine, against localhost. Replaces scripts like `wait-for-healthy.sh`.

- **Fail fast when a server crashes**
  ``const server = await $`pnpm start`.background();``
  ``await Promise.race([server.exited().then(() => { throw ... }), $`pnpm e2e`]);``
  A dead server fails the job with its logs instead of the tests timing out.

- **Server logs, without uploading them**
  `await server.output()`
  The retained output is a step, so it's in the trace rather than in an "upload logs if failure" step.

- **Wait for other checks on a commit**
  `await github.waitForChecks({ sha, names: ["vercel"] })`
  Waits for `github/check_run.completed`, with no machine kept busy.

- **Wait for a GitHub Actions workflow**
  `await github.waitForWorkflow({ workflow: "npm_test.yml", sha })`
  Waits for `workflow_run.completed`, so jobs that need macOS or Windows can stay where they are during a migration.

- **Run another repo's pipeline and get the result**
  `await step.invoke("contracts", { function: contracts, data: { sha } })`
  Already built into Inngest. Replaces `repository_dispatch` and polling.

## Tests

- **Build once, test many**
  `await from(build)`
  Every suite starts from one build instead of compiling it again per job.

- **Skip tests that can't have changed**
  `cache: { key: files("src/**", "test/**") }`
  Reused results show as passed, with a link to the run that proved it.

- **Split tests across shards**
  ``await shard({ total: 4, index, files }, (chunk) => $`pnpm vitest ${chunk}`)``
  No fixed `index: [0, 1, 2, 3, 4]` matrices.
  **Not yet:** `by: "timing"` needs run history the platform doesn't expose, so it falls back to splitting by count and warns.

- **Rerun only the tests that failed**
  **Not yet:** ``$`pnpm test`.junit("junit.xml").retryFailed(2)`` needs a JUnit parser, which isn't built. `.retries(n)` reruns the whole command today.

- **Spot flaky tests**
  **Not yet:** flagging a test that fails then passes on the same commit needs per-test history. A command's retries are visible on the check in the meantime: "Attempt 2 of 2", with why the first one failed.

- **Dump state when a command hangs**
  `await $\`pnpm test\`.timeout("10m").onTimeout(() => $\`ps auxf\`)`
  Replaces a silent six-hour hang.

## Pull request feedback

- **Checks without writing status code**
  Automatic. One check per pipeline and per job, always reported, with failures summarised and linked to the trace.

- **One comment, updated in place**
  `await github.stickyComment("preview", \`Preview: ${url}\`)`
  Replaces a marketplace action that finds and edits your old comment.

- **Test failures as inline annotations**
  `await report.annotate([{ path, line, message }])`
  Puts failing tests on the diff and in the job's check.
  **Not yet:** `report.junit("junit.xml")` needs the JUnit parser. Read the report with a command and call `report.annotate()` for now.

- **Open or update a pull request**
  `await github.upsertPullRequest({ head: "release/next", title, body })`
  Replaces "find the existing PR, then create or edit it" scripts.

- **"You broke main", then "main is green again"**
  A small pipeline on `github.checkSuite({ branch: "main" })` that remembers the last result.

## Changes and triggers

- **Run only when certain files changed**
  `if (await changed("docs/**")) await docsSite()`
  One pipeline instead of several near-identical workflows with path filters, and the required check still reports.

- **Trigger on pushes to another repo**
  `on: github.push({ repo: "inngest/inngestgo", branches: ["main"] })`
  Replaces hourly cron jobs that check for upstream changes.

- **Slash commands, with a permission check**
  `on: github.comment({ command: "/prerelease", minPermission: "write" })`
  Replaces parsing the comment and calling the permissions API in bash.

- **Manual runs with typed inputs**
  `on: ci.manual({ schema: z.object({ env: z.enum(["preview", "production"]) }) })`
  From the dashboard or the CLI, instead of `workflow_dispatch` strings.

- **Update a branch or create a tag, without a machine**
  `await github.forcePushRef("heads/next", sha)`
  No runner, no checkout, and no bot token needed so the push triggers other pipelines.

- **A merge queue**
  `batchEvents: { maxSize: 10, timeout: "5m" }` on PR approval events
  Tests approved PRs together, merges on green, and bisects on red.

## Calling services

- **Any GitHub API call, retried and traced**
  `await github.rest.repos.createRelease({ tag_name: "v1.4.0" })`
  Every Octokit method, authenticated and rate-limit aware, with no marketplace action.

- **Rate limits without sleeping**
  `throw new RetryAfterError("Rate limited", "30s")`
  The retry is scheduled for later, so nothing waits in the meantime. Built into `github.rest`.

## Debugging and credentials

- **Keep the machine when something fails**
  `ci.job({ id: "test", keepOnFailure: "24h" }, fn)`
  Snapshots the failed machine. The snapshot ID is on the job's check and in the run's summary.
  **Not yet:** `shell(runId)` to open a shell on it needs interactive exec.

- **Cloud credentials without long-lived secrets**
  **Not yet:** `oidc.aws({ role: "deployer" })` needs an OIDC issuer. Fetch credentials in a `step.run` and pass them with `withSecret()` for now.

---

## What isn't built yet

Everything here is typed, marked `@deprecated` in your editor, and throws or warns with a message saying what to do instead. [NOTES.md](./NOTES.md) says what each one needs.

| API | Behaviour today |
|---|---|
| `machine.image`, `machine.arch` | Ignored, with a warning |
| `ExtraMachine.url(port)` | Throws: machines can't reach each other |
| `withSecret()` | Works, but isn't isolated from code on the machine |
| `shell(runId)` | Throws: no interactive exec |
| `inngestCacheStore()` | Throws: no hosted store. Use `memoryCacheStore()` or `fileCacheStore()` |
| `shard({ by: "timing" })` | Falls back to `by: "count"`, with a warning |
| `report.junit()`, `$.junit()`, `.retryFailed()` | Throw: no JUnit parser |
| `oidc.aws()`, `oidc.gcp()` | Throw: no OIDC issuer |
| `vercel.waitForDeployment()` | Throws: out of scope. Use `github.waitForChecks()` |
| `rerunFromFailedJob` | Throws: the REST API can't rerun from a step |

Two more things to know, neither of them typed:

- **Machines don't run against the local Dev Server yet**, so a command can't run locally.
- **`github.waitForChecks()` and `waitForWorkflow()` have a race**: a check that completes between the first read and the wait is missed, so that name times out.
