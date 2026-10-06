# CI pipelines example

Pipelines for a small app, written with [`@inngest/ci`](../../packages/ci) and run on Inngest Sandboxes.

> [!NOTE]
> `@inngest/ci` is an [Inngest Labs](https://www.inngest.com/docs/labs) project, so APIs may change between 0.x releases.

```
ci/
├─ client.ts      Inngest client and createCi
├─ helpers.ts     plain functions that run commands
├─ jobs.ts        base, lint, test, compat, e2e, two-machines, release
└─ pipelines.ts   pr, docs, release, prerelease
app/              the project the pipelines install, lint, and test
e2e/              end-to-end cases for @inngest/ci, run on real Sandboxes
scripts/          send.ts sends local events, github-forwarder.ts forwards real ones
server.ts         serves ci.functions()
```

## Before you start

- Node.js 20 or newer.
- An Inngest account with access to Sandboxes.
- The Inngest CLI, signed in once:

```bash
npx inngest-cli@latest login
```

## 1. Build the packages

This example runs against the packages in this repository.

```bash
pnpm -C packages/inngest build
pnpm -C packages/ci build
```

## 2. Install

```bash
cd examples/ci-pipelines
pnpm install
```

## 3. Start the Dev Server

```bash
npx inngest-cli@latest dev
```

## 4. Start the app

```bash
INNGEST_DEV=1 pnpm dev
```

`server.ts` serves the pipelines at `http://localhost:3939/api/inngest`. The Dev Server finds it on its own. If it does not, add the URL in the Dev Server UI.

## 5. Send a pull request

```bash
INNGEST_DEV=1 pnpm ci:send pr
```

`scripts/send.ts` builds the event from this git repository: `HEAD` is the head commit and `origin/main` is the base. `checkout()` uploads your working tree, so there is nothing to push.

Open `http://localhost:8288` to see the trace. Checks print in the terminal running `pnpm dev`.

## Things to try

1. Send `pnpm ci:send pr` again. `base` is cached on `pnpm-lock.yaml`, so its check says `Restored` and no machine starts.
2. Break a test without committing. Edit `app/src/sum.ts`, then send `pr`. `test` fails with the end of its output on the check.
3. Send `pr` twice in a row. `singleton` cancels the first run.
4. Make a test flaky. Add `.env({ FLAKY: "1" })` to the `pnpm test` command in `ci/jobs.ts`, then send `pr`. `app/src/sum.test.ts` fails about half the time, and `.retries(1)` runs the command again. The check shows the attempt count and the failure.
5. Send `pnpm ci:send docs` on a change with no documentation. The pipeline returns `ci.skip()` and its check still completes.
6. Send `pnpm ci:send release --event push`, then send a `release/approved` event from the Dev Server UI with `data.sha` set to the commit being released. `release` waits for a matching event with `step.waitForEvent`.
7. Send `pnpm ci:send prerelease --event comment --body "/prerelease beta"`.

## What each file shows

| File | Look at |
| --- | --- |
| `ci/jobs.ts` `base` | A cached job with a nightly refresh |
| `ci/jobs.ts` `lint`, `test` | `from(base)` starts on a copy of the `base` machine |
| `ci/jobs.ts` `compat` | `ci.matrix`, one job per Node version |
| `ci/jobs.ts` `e2e` | `.background()` and `waitForHttp()` |
| `ci/jobs.ts` `two-machines` | `sandbox()` for a second machine |
| `ci/jobs.ts` `release` | `step.waitForEvent` and `github.rest` |
| `ci/pipelines.ts` `pr` | `singleton`, `changed()`, and `ci.skip()` |
| `ci/pipelines.ts` `prerelease` | `github.comment()` with a permission check |

## End-to-end tests

`e2e/` is the integration test for `@inngest/ci`. Each case is a pipeline that runs on real Sandboxes against a throwaway git repository, and `e2e/run.ts` checks what it returned.

```bash
INNGEST_DEV=1 pnpm ci:e2e
INNGEST_DEV=1 pnpm ci:e2e commands matrix
```

It needs the Dev Server from step 3, but not `pnpm dev`. It serves its own functions on port 3940.

## Run on GitHub

1. Set up a GitHub App as described in the [Run on GitHub docs](https://www.inngest.com/docs/labs/ci/reference#run-on-github).
2. Set the app's credentials, then send a pull request. `ci/client.ts` reads them.

```bash
export GITHUB_APP_ID=...
export GITHUB_APP_PRIVATE_KEY="$(cat key.pem)"
export INNGEST_CI_GITHUB=live
INNGEST_DEV=1 pnpm ci:send pr
```

To receive real webhooks locally, forward them to the Dev Server:

```bash
INNGEST_DEV=1 pnpm ci:forward
gh extension install cli/gh-webhook
gh webhook forward --repo=owner/name --events='*' --url=http://localhost:3950 --secret="$GITHUB_WEBHOOK_SECRET"
```

Set `GITHUB_WEBHOOK_SECRET` to the secret GitHub signs with. The forwarder verifies `X-Hub-Signature-256`, refuses to start without it, and listens on `127.0.0.1:3950` (override the port with `FORWARDER_PORT`).
