# Inngest CI

CI in TypeScript. A **pipeline** runs on an event and calls **jobs**. Each job gets its own machine on its first **command**.

> [!IMPORTANT]
> **Experimental.** APIs can change without a major version bump. Deprecated APIs are placeholders for unbuilt platform features.

Runnable example: [`examples/ci-pipelines`](../../../../../examples/ci-pipelines).

## Contents

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
  - [Checks](#checks)
  - [GitHub](#github)
  - [Steps inside jobs](#steps-inside-jobs)
- [Setup](#setup)
- [Running locally](#running-locally)
- [Putting it together](#putting-it-together)
- [Recipes](#recipes)
- [What isn't built yet](#what-isnt-built-yet)

```ts
// ci/pipelines.ts
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

```ts
// ci/jobs.ts
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

## Concepts

Inngest orchestrates your CI. Pipelines live in your app, and Inngest runs them
using Sandboxes. You get:

- **Durable jobs.** Failed jobs retry alone. Passed jobs never rerun.
- **Plain code.** `if`, loops, `Promise.all`, types, and your own SDKs. No YAML
  config yay.
- **Machines on demand.** No commands, no machine; waiting jobs don't pay.
- **Less repeated work.** Start from another job's machine. Skip unchanged jobs.
- **Automatic GitHub checks.** One per pipeline, one per job.
- **Full traces.** Every command and API call is a step.
- **Flow control.** Cancel stale runs, dedupe, cap concurrency, merge queues.

| Concept | What it does | Support |
|---|---|---|
| [`ci.pipeline()`](#pipelines) | Runs on a trigger and calls jobs | 🟢 Full |
| [Triggers](#triggers) | Start a pipeline and type its `event` | 🟢 Full |
| [`ci.job()`](#jobs) | Durable unit of work with its own machine and check | 🟢 Full |
| [`` $`…` ``](#commands) | Runs a command on the job's machine | 🟡 Partial |
| [Machines](#machines) | One per job, created on first command | 🟡 Partial |
| [`from()`](#starting-from-another-job) | Starts a job from a copy of another job's machine | 🟡 Partial |
| [`sandbox()`](#extra-machines) | Extra machines for one job | 🟡 Partial |
| [`ci.matrix()`](#matrices) | Runs a job for every input combination | 🟢 Full |
| [`cache`](#caching) | Skips a job when its inputs haven't changed | 🟡 Partial |
| [Checks and `report`](#checks) | Reports to GitHub automatically | 🟢 Full |
| [`github`](#github) | GitHub REST API as durable steps, plus helpers | 🟢 Full |
| [`step.*` in jobs](#steps-inside-jobs) | The Inngest step API inside a job | 🟢 Full |

🟢 Works. 🟡 Works, with limits. 🔴 Typed, but throws or is ignored.

Unit tests use fake sandbox and GitHub layers. The example's `pnpm ci:e2e` runs against real sandboxes.

## Pipelines

> [!TIP]
> **🟢 Full support.**

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

Plain async code. The handler gets `event`, `events`, `runId`, `pipelineId`, `attempt`, `logger`, and `repo`.

### When something fails

```ts
async () => {
  await test();     // passes
  await deploy();   // fails with a 503, retried with backoff
  await e2e();      // runs once deploy succeeds
}
```

`test` doesn't rerun. Inside a job, finished commands don't rerun either.

### Flow control

Pipelines take all Inngest flow control options.

```ts
export const pr = ci.pipeline(
  {
    id: "pr",
    on: [github.pullRequest(), github.push()],

    // New push cancels the running one
    singleton: { key: "event.data.pull_request.number", mode: "cancel" },

    // Run each commit once
    idempotency: "event.data.sha",

    // Max 20 machines across the org
    concurrency: {
      key: "event.data.repository.owner.login",
      limit: 20,
      scope: "account",
    },
  },
  async () => { /* ... */ },
);
```

## Triggers

> [!TIP]
> **🟢 Full support.** Max 10 triggers per pipeline. `pullRequest({ types })` uses one per type. `comment()` checks `minPermission` after the run starts.

```ts
on: github.pullRequest({ branches: ["main"] })
on: github.push({ branches: ["main"], tags: ["v*"] })
on: github.comment({ command: "/prerelease", minPermission: "write" })
on: github.mergeGroup()
on: github.checkSuite({ branch: "main" })
on: { cron: "0 3 * * *" }
on: ci.manual({ schema })
```

Pass an array for several. The trigger types the event:

```ts
ci.pipeline({ id: "pr", on: github.pullRequest() }, async ({ event }) => {
  event.data.pull_request.head.sha;  // string
  event.data.action;                 // "opened" | "synchronize" | "reopened"
});
```

- `types` narrows it: `types: ["closed"]` adds `pull_request.merged`.
- Several triggers give a union. Narrow it:

  ```ts
  const sha = "pull_request" in event.data
    ? event.data.pull_request.head.sha
    : event.data.after;
  ```

- Cron: `event.data` is an open record.
- `ci.manual({ schema })`: `event.data` follows the schema.

## Jobs

> [!TIP]
> **🟢 Full support.**

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
  return vercel.deploy({ token: process.env.VERCEL_TOKEN });  // no machine
});
```

```ts
ci.job("test", fn)
ci.job({ id: "build", machine: { vcpu: 4 } }, fn)
```

- Call jobs like functions. They can return values.
- Jobs never share a machine.
- A job runs once per pipeline run. Two callers share the result.

## Commands

> [!WARNING]
> **🟡 Partial support.** Needs Cloud sandboxes. Polls for exit, so `.timeout()` is approximate. Output arrives when the command ends. `.junit()` and `.retryFailed()` throw.

```ts
await $`pnpm test`;
await $`pnpm --filter ${pkg} test`;              // values are args, no quoting
await $`pnpm test ${bail && ["--bail", "1"]}`;   // arrays spread, falsy values dropped
```

Non-zero exit fails the job. Options chain:

```ts
await $`pnpm test`.retries(2);
await $`pnpm lint`.nothrow();                   // return exit code, don't fail
await $`pnpm test`.env({ CI: "true" });
await $`pnpm test`.cwd("/work/app");
await $`pnpm test`.timeout("10m");
await $`pnpm test`.onTimeout(() => $`ps auxf`);
await $`pnpm start`.background();
await $`pnpm exec playwright test`.as("e2e");   // trace name

const sha = await $`git rev-parse HEAD`.text();
const files = await $`git ls-files`.lines();
const meta = await $`cat package.json`.json<{ name: string }>();

await $.sh`pnpm build && pnpm test | tee test.log`;  // shell syntax
```

`$` from `inngest/ci` outside a job throws.

### Sharing commands

Any function can run commands. It uses the calling job's machine.

```ts
// ci/helpers.ts
export async function install() {
  await checkout();
  await $`pnpm install --frozen-lockfile`;
}

// ci/jobs.ts
export const test = ci.job("test", async () => {
  await install();
  await $`pnpm test`;
});
```

## Machines

> [!WARNING]
> **🟡 Partial support.** Only `vcpu` (1, 2, 4) works. `image` and `arch` are ignored. `withSecret()` values are readable on the machine.

- Created on the job's first command.
- Destroyed when the pipeline ends.
- No commands, no machine.

Only `$` runs on the machine. Everything else runs in your app. Pass secrets explicitly:

```ts
await $`pnpm publish`.withSecret("NPM_TOKEN", token);
```

Masked in step input, output, and checks.

## Starting from another job

> [!WARNING]
> **🟡 Partial support.** Needs snapshots. Without them, `from()` uses a fresh machine.

```ts
// ci/jobs.ts
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

// ci/pipelines.ts
await Promise.all([lint(), test()]);
```

```
pr
├─ setup   machine
├─ lint    copy of setup
└─ test    copy of setup
```

- `setup` runs once. Copies are isolated.
- `from()` returns the parent's result.
- Choose the parent at runtime:

  ```ts
  await from((await changed("docs/**")) ? docsSetup : setup);
  ```

- `await setup()` runs it on its own machine. `await from(setup)` copies its machine.
- `from()` goes before the first command. One parent per job.

## Extra machines

> [!WARNING]
> **🟡 Partial support.** Machines can't reach each other. `api.url(port)` throws.

```ts
export const e2e = ci.job("e2e", async () => {
  const api = await sandbox("api");
  await api.$`pnpm start`.background();
  await api.waitForPort(3000);

  await checkout();
  await $`pnpm install`;
  await $`pnpm exec playwright test`;
});
```

Plain `$` is still the job's machine. For now, run servers on the job's machine:

```ts
await $`pnpm start`.background();
await waitForPort(3000);
await $`pnpm exec playwright test`.env({ API_URL: "http://127.0.0.1:3000" });
```

| Work | Use |
|---|---|
| Independent | Separate jobs |
| Builds on earlier work | Separate jobs with `from()` |
| Needs machines talking | One job with `sandbox()` |

## Matrices

> [!TIP]
> **🟢 Full support.** `failFast` doesn't cancel running combinations.

One input: wrap a job.

```ts
export const compat = (node: string) =>
  ci.job(`compat (node:${node})`, async () => {
    await checkout();
    await $`fnm use ${node}`;
    await $`pnpm test`;
  })();

await Promise.all(["20", "22", "24"].map(compat));
```

IDs come from inputs, so each retries alone and adding one doesn't affect others.

Several inputs: `ci.matrix`.

```ts
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

await compat();                               // all combinations
await compat({ node: "22", db: "postgres" }); // one
```

Also: `concurrency`, `failFast` (off by default).

## Caching

> [!WARNING]
> **🟡 Partial support.** No hosted store. `memoryCacheStore()` (default) is per process, `fileCacheStore()` per disk. Restoring machines needs snapshots.

```ts
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

- **`key`**: unchanged key means the job is reused. No machine. `from(setup)` uses the saved machine.
- **`refresh`**: triggers that rebuild the cache ahead of time.

```ts
key: files("pnpm-lock.yaml")
key: files("migrations/**", "seeds/**")
key: [files("go.mod", "go.sum"), "go1.25"]
```

- Jobs using `from(setup)` include setup's key. Change the lockfile, rebuild the chain.
- A new job's first run always misses.
- Jobs like `test` can cache too. Reused results show as passed.
- Don't cache tests that use the network.

```
pr
├─ setup   restored, built 5h ago by the nightly refresh
├─ lint    copy of setup
└─ test    passed at a3f91c2, no changes since
```

## Checks

> [!TIP]
> **🟢 Full support.** Re-run restarts the whole pipeline. `rerunFromFailedJob` and `report.junit()` throw.

Automatic. One check per pipeline (require this one), one per job.

```
✕ pr                   test failed
✓ pr / setup           restored, built 5h ago
✓ pr / lint            passed in 22s
✕ pr / test            pnpm test exited with 1
```

| Event | Check |
|---|---|
| Running | In progress, current command |
| Retrying | In progress, attempt count and last error |
| Passed | Success, duration |
| Cached | Success, "Passed at a3f91c2" |
| Failed | Failure, command, output tail, annotations |
| Never started | No check |
| Cancelled by a failure | Cancelled |
| Superseded by a push | Cancelled, "Superseded by b41e9d0" |
| Returned early | Success, with reason |

- Required checks always report.
- Matrices don't break branch protection.
- Superseded runs are cancelled.
- Fork PRs get checks.

```ts
await report.summary(`Coverage: **${coverage}%**`);
await report.annotate([{ path: "src/queue.ts", line: 42, message: "Flaky retry here" }]);

ci.pipeline({ id: "pr", on: github.pullRequest(), check: { name: "CI" } }, fn)
ci.job({ id: "notify", check: false }, fn)
```

## GitHub

> [!TIP]
> **🟢 Full support.** `waitForChecks()` and `waitForWorkflow()` can miss a check that finishes before the wait starts.

### `github.rest`

Every Octokit REST method. Each call is a step.

```ts
export const release = ci.job("release", async () => {
  const release = await github.rest.repos.createRelease({ tag_name: "v1.4.0", generate_release_notes: true });
  await github.rest.git.updateRef({ ref: "heads/next", sha: github.repo().sha, force: true });
  return release.html_url;
});

await github.rest.with({ id: "tag-release" }).git.createRef({ ref: "refs/tags/v1.4.0", sha });
```

- `owner` and `repo` default to the triggering repo.
- Returns `data`.
- Auth and rate limits handled.
- Inside `step.run` or outside a pipeline, calls run directly.
- Results are JSON: dates are strings. Keep them small.
- No streaming methods. Use `github.octokit()` in `step.run`.
- Creates can rarely run twice. Helpers guard against it.

### Helpers

| Helper | Does |
|---|---|
| `stickyComment(key, body)` | One PR comment, updated each run |
| `upsertPullRequest({ head, base, title, body })` | Opens or updates a PR |
| `forcePushRef(ref, sha)` | Moves or creates a branch or tag |
| `canUser(login, permission)` | Checks a user's permission |
| `waitForChecks({ names, sha? })` | Waits for checks, no machine |
| `waitForWorkflow({ workflow, sha? })` | Waits for an Actions workflow |
| `paginate(method, params)` | All pages, typed |
| `graphql(query, variables)` | GraphQL query |
| `repo()` | `owner`, `repo`, `sha`, `number` |
| `token()` | Short-lived token. `step.run` only |
| `octokit()` | Plain Octokit. `step.run` only |

Helpers are plain `step.run` code. Copy and change them:

```ts
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

## Steps inside jobs

> [!TIP]
> **🟢 Full support.**

Commands never rerun. Other job code reruns on resume. Wrap side effects in `step.run`:

```ts
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

Step IDs are scoped per job. The full step API works. The machine pauses during waits:

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

Rate limited? Throw `RetryAfterError`:

```ts
await step.run("sync-customers", async () => {
  try {
    return await stripe.customers.list({ limit: 100 });
  } catch (err) {
    if (err.statusCode === 429) throw new RetryAfterError("Rate limited", "30s");
    throw err;
  }
});
```

---

## Setup

### 1. Install

```bash
npm install inngest
```

Prototype: build and link it instead.

```bash
cd packages/inngest && pnpm build
cd your-project && pnpm add inngest@link:../inngest-js/packages/inngest/dist
```

### 2. Create the client

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

### 3. Serve

`ci.functions()` includes pipelines plus cleanup and cache functions.

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

1. Create a GitHub App with:
   - Checks: read and write
   - Commit statuses: read and write
   - Contents: read
   - Pull requests: read and write
   - Issues: read and write
   - Metadata: read
2. Subscribe to: push, pull request, check run, check suite, issue comment, merge group.
3. Create an Inngest webhook with the `githubWebhookTransform` transform. Use its URL.
4. Install the app on your repos.
5. Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.

> [!WARNING]
> **🟡 Webhooks aren't verified.** Keep the webhook URL secret.

### File layout

```
ci/
├─ client.ts      client and CI setup
├─ helpers.ts     plain functions
├─ jobs.ts        ci.job, ci.matrix
└─ pipelines.ts   ci.pipeline
```

## Running locally

> [!WARNING]
> **🟡 Partial support.** Commands need an unreleased Dev Server build with `--cloud-sandboxes` (inngest/inngest#4886). Without it, jobs stop at the first `$`.

```bash
inngest dev --cloud-sandboxes   # or `npx inngest-cli@latest dev` without commands
```

Open the **Cloud sandboxes** link, sign in, and connect an environment. Then:

```bash
export INNGEST_DEV=http://127.0.0.1:8288
export INNGEST_SANDBOX_DEV_TOKEN=...   # printed by the Dev Server
```

Send an event from your working tree, uncommitted changes included:

```bash
pnpm ci:send pr --event pull_request.opened
```

Checks print to the terminal:

```
[pr] ✓ setup      restored
[pr] ✕ test       pnpm test exited with 1
[pr]   → http://localhost:8288/run?runID=01J…
```

- Real checks: set `INNGEST_CI_GITHUB=live` with app credentials.
- Real webhooks: use the example's forwarder with `gh webhook forward` or smee.io.

---

## Recipes

### Services and waiting

| Task | Code |
|---|---|
| Wait for a port | `await waitForPort(3000)` |
| Wait for a health check | `await waitForHttp("http://127.0.0.1:8288/health")` |
| Fail fast on server crash | ``Promise.race([server.exited().then(fail), $`pnpm e2e`])`` |
| Server logs | `await server.output()` |
| Wait for other checks | `await github.waitForChecks({ sha, names: ["vercel"] })` |
| Wait for an Actions workflow | `await github.waitForWorkflow({ workflow: "npm_test.yml", sha })` |
| Run another repo's pipeline | `await step.invoke("contracts", { function: contracts, data: { sha } })` |

### Tests

| Task | Code |
|---|---|
| Build once, test many | `await from(build)` |
| Skip unchanged tests | `cache: { key: files("src/**", "test/**") }` |
| Shard tests | ``await shard({ total: 4, index, files }, (chunk) => $`pnpm vitest ${chunk}`)`` |
| Dump state on hang | ``$`pnpm test`.timeout("10m").onTimeout(() => $`ps auxf`)`` |
| 🟡 Shard by timing | `by: "timing"` falls back to count |
| 🔴 Rerun failed tests | ``$`pnpm test`.junit("junit.xml").retryFailed(2)`` |
| 🔴 Spot flaky tests | Needs per-test history |

### Pull requests

| Task | Code |
|---|---|
| Sticky comment | ``await github.stickyComment("preview", `Preview: ${url}`)`` |
| Annotations | `await report.annotate([{ path, line, message }])` |
| Open or update a PR | `await github.upsertPullRequest({ head: "release/next", title, body })` |
| Alert on broken main | Pipeline on `github.checkSuite({ branch: "main" })` |
| 🔴 JUnit annotations | `report.junit("junit.xml")` |

### Changes and triggers

| Task | Code |
|---|---|
| Run on changed files | `if (await changed("docs/**")) await docsSite()` |
| Trigger on another repo | `on: github.push({ repo: "inngest/inngestgo", branches: ["main"] })` |
| Slash commands | `on: github.comment({ command: "/prerelease", minPermission: "write" })` |
| Typed manual runs | `on: ci.manual({ schema: z.object({ env: z.enum(["preview", "production"]) }) })` |
| Move a branch, no machine | `await github.forcePushRef("heads/next", sha)` |
| Merge queue | `batchEvents: { maxSize: 10, timeout: "5m" }` on approval events |

### Debugging and credentials

| Task | Code |
|---|---|
| Keep failed machine | `ci.job({ id: "test", keepOnFailure: "24h" }, fn)` |
| 🔴 Shell into it | `shell(runId)` |
| 🔴 Cloud OIDC | `oidc.aws({ role: "deployer" })`. Use `withSecret()` for now |

---

## What isn't built yet

> [!CAUTION]
> **🔴 Not supported.** Typed and `@deprecated`. Throws or warns.

| API | Today |
|---|---|
| `machine.image`, `machine.arch` | Ignored |
| `ExtraMachine.url(port)` | Throws: no networking between machines |
| `shell(runId)` | Throws: no interactive exec |
| `inngestCacheStore()` | Throws: no hosted store |
| `shard({ by: "timing" })` | Falls back to `"count"` |
| `report.junit()`, `$.junit()`, `.retryFailed()` | Throw: no JUnit parser |
| `oidc.aws()`, `oidc.gcp()` | Throw: no OIDC issuer |
| `vercel.waitForDeployment()` | Throws. Use `github.waitForChecks()` |
| `rerunFromFailedJob` | Throws: no rerun from a step |

Also:

- Commands need Cloud sandboxes, even locally.
- `$` can't run outside a pipeline run.
