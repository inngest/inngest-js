# Inngest CI example

CI written in TypeScript, running on Inngest. A **pipeline** is an Inngest
function, a **job** is a group of steps with a lazily created machine, and a
**command** is a step on that machine.

> **Experimental.** `inngest/ci` is an early prototype. APIs marked deprecated
> in your editor are typed placeholders for things the platform doesn't support
> yet, and everything here can change without a major version bump.

```
ci/
├─ client.ts      the Inngest client and CI setup
├─ services.ts    a fake deploy SDK whose first call fails
├─ helpers.ts     plain functions that run commands
├─ jobs.ts        ci.job and the curried job factories
└─ pipelines.ts   ci.pipeline
app/              the tiny project the pipelines build and test
server.ts         serve() with ci.functions()
scripts/          send.ts (local events) and github-forwarder.ts (real ones)
```

## Setup

This example runs against the SDK in this repository rather than a published
version, so build it first:

```bash
cd packages/inngest && pnpm build
cd ../../examples/ci-pipelines && pnpm install --ignore-workspace
```

Then start the Dev Server with Cloud sandboxes, and this app:

```bash
inngest dev --cloud-sandboxes         # in one terminal
pnpm dev                              # in another, with the env below
```

Machines are real Cloud sandboxes, so the Dev Server needs a CLI build with
`--cloud-sandboxes` (inngest/inngest#4886). Open the **Cloud sandboxes** link it
prints, sign in, and connect a development environment with sandbox access.
Then give this app the token it printed:

```bash
export INNGEST_DEV=http://127.0.0.1:8288
export INNGEST_SANDBOX_DEV_TOKEN=...  # printed by `inngest dev --cloud-sandboxes`
```

On a machine with no OS keyring (WSL, a container), sign in with
`inngest login --insecure-storage` first, which keeps the credential in a
user-only file.

The app serves its functions at `http://localhost:3939/api/inngest`.

## End-to-end tests

`pnpm ci:e2e` runs one pipeline per area of the API against real sandboxes
and checks what each returned. `pnpm ci:e2e commands matrix` runs just those.
It needs the Dev Server and token above, but not `pnpm dev`: it serves its own
functions on port 3940.

## Demo

1. **Run the pull request pipeline.**

   ```bash
   pnpm ci:send pr
   ```

   The payload is built from this git repository: `HEAD` is the head commit,
   `origin/main` is the base, and `checkout()` uploads your working tree, so
   there's nothing to push. Watch the trace fill in at
   `http://localhost:8288`, and the checks print in the terminal running
   `pnpm dev`:

   ```
   [pr] … pr
   [pr] … pr / setup
   [pr] ✓ pr / setup   Passed in 42s   → http://localhost:8288/run?runID=01J…
   ```

2. **Send it again.** `setup` is cached on the lockfile, so its check reads
   `Restored, built 2m ago by github/pull_request.opened` and no machine
   starts. The cache is on disk in `.inngest/ci-cache`.

3. **Break a test without committing.** Edit `app/src/sum.ts` so `sum` adds
   one too many, then `pnpm ci:send pr`. `test` fails with the end of its
   output on the check, and the `pr` check fails naming the job.

4. **Supersede a run.** Send `pr` twice in quick succession. `singleton:
   { key: "event.data.pull_request.number", mode: "cancel" }` cancels the run
   already in progress rather than leaving its check spinning.

5. **Watch a retry.** Set `FLAKY=1` in `app/src/sum.test.ts`'s environment
   (the `test` job runs `$\`pnpm test\`.retries(1)`), then send `pr`. The
   first attempt fails, the second passes, and the check shows
   "Attempt 1 of 2" with the failure.

6. **Nothing to do.** `pnpm ci:send docs` on a change that touches no
   documentation. The pipeline returns `ci.skip("no documentation changed")`
   and its check still **completes** as success, so a required check never
   hangs.

7. **A retry with no machine.** Open the `deploy` job in the trace. It has no
   machine at all: its `step.run("create-deployment")` failed once (the fake
   SDK's first call always does) and succeeded on the retry, while everything
   that already passed stayed passed.

8. **Optional: real GitHub.** With a GitHub App configured:

   ```bash
   export GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY="$(cat key.pem)"
   export GITHUB_INSTALLATION_ID=...
   export INNGEST_CI_GITHUB=live
   pnpm ci:send pr
   ```

   Checks are posted for real, `github.rest` calls appear in the trace, and
   **Re-run** on a check re-runs the pipeline. To receive real webhooks,
   run `pnpm ci:forward` and point `gh webhook forward` or smee.io at it.

## What this example shows

| In `ci/` | What to look at |
|---|---|
| `jobs.ts` `setup` | a cached job with a nightly refresh trigger |
| `jobs.ts` `lint`, `test` | `from(setup)`: a copy of setup's machine |
| `jobs.ts` `compat` | a curried job factory, one job per Node version |
| `jobs.ts` `deploy` | a job with no machine, calling an SDK inside `step.run` |
| `jobs.ts` `e2e` | a background process, then `waitForHttp` |
| `jobs.ts` `twoMachines` | `sandbox("api")` for a second machine |
| `jobs.ts` `release` | `step.waitForEvent`, `github.rest`, and helpers |
| `pipelines.ts` `pr` | `singleton`, `changed()`, and `ci.skip()` |
| `pipelines.ts` `prerelease` | a slash command with a permission check |

## CI annoyances these defaults address

1. **A required check never hangs.** The pipeline check always completes,
   including on early returns and failures.
2. **Matrices don't break branch protection.** Require the `pr` check; job
   checks come and go as jobs do.
3. **Superseded runs are cancelled with a reason**, instead of spinning.
4. **Retries are visible** in the check summary, not just the logs.
5. **Cache hits say "Restored" or "Passed at …"**, never "Skipped".
6. **Fork pull requests get checks**, because the App token writes them.
7. **Re-run on a check re-runs the pipeline.**
8. **Failure output and a trace link are on the check**, so there's no log
   hunting.
9. **Annotation and summary limits are handled** (50 annotations per request,
   65,000 characters of summary).
10. **Step retries don't create duplicate check runs**, because a create is
    matched by `external_id` first.

Items 1, 2, 3, 4, 5, 9, and 10 have tests in
`packages/inngest/src/components/ci/`.

## Known limitations

These are prototype limits, not design decisions. The full list, and what
each one needs, is in `packages/inngest/src/components/ci/NOTES.md`.

- **Machines need `inngest dev --cloud-sandboxes`.** A plain Dev Server has no
  sandbox API, so everything up to a job's first command works, and commands
  fail. CI's unit tests run against a fake sandbox API; `pnpm ci:e2e` runs
  against real ones.
- **Snapshots**: if the environment doesn't support them, `from()` falls back
  to a fresh machine and says so on the check. An environment whose snapshot
  limit is used up fails `from()` and cached machines instead.
- **No networking between machines**, so `ExtraMachine.url()` throws. Run the
  server on the job's own machine and use `127.0.0.1`.
- **`withSecret()` isn't isolated** from code on the machine. The value never
  appears in step input, output, or check output, but it is an environment
  variable on the machine.
- **JUnit parsing, OIDC, interactive `shell()`, and a hosted cache store**
  are typed and deprecated, and throw with an explanation.

### Where this differs from the docs

- The docs show `report.junit("junit.xml")` and `$.junit().retryFailed()`.
  There's no JUnit parser in the prototype, so those throw
  `CiNotSupportedError`. Read the file with a command and call
  `report.annotate()`.
- The docs show `api.url(3000)` for an extra machine. Machines can't reach
  each other yet, so that throws; this example's `e2e` job runs its server on
  the job's own machine instead.
- `shard({ by: "timing" })` falls back to `by: "count"` with a warning, since
  there's no timing history to split on.
