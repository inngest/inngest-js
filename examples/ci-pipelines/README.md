# CI pipelines example

Pipelines for a small app, written with [`@inngest/ci`](../../packages/ci) and run on Inngest Sandboxes.

> [!NOTE]
> `@inngest/ci` is an [Inngest Labs](https://www.inngest.com/docs/labs) project, so APIs may change between 0.x releases.

```
ci/
├─ client.ts      Inngest client and createCi
├─ helpers.ts     plain functions that run commands
├─ jobs.ts        base, lint, test, build, compat, e2e, two-machines, release
└─ pipelines.ts   pr, docs, release, deploy, prerelease
app/              the project the pipelines install, lint, and test
e2e/              end-to-end cases for @inngest/ci, run on real Sandboxes
scripts/          github-forwarder.ts forwards real GitHub events
inngest.json       tells inngest-ci how to start server.ts
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
pnpm install --ignore-workspace
```

The example isn't part of the monorepo's pnpm workspace, so a plain `pnpm install` here installs the workspace instead.

## 3. Run a pipeline

```bash
pnpm run ci pr
```

`inngest-ci` starts a Dev Server and `server.ts`, then sends a pull request event built from this git repository: `HEAD` is the head commit and `origin/main` is the base. `checkout()` uploads your working tree, so there is nothing to push. `inngest.json` tells it how to start the app.

`inngest-ci` needs a Dev Server binary. Install `inngest-cli`, or point `INNGEST_CI_DEV_SERVER_BIN` at a local build. See [Run locally](../../packages/ci/README.md#run-locally).

Press `enter` to open the run's trace. `pr` has several triggers, so a plain terminal run uses the first, `pull_request.opened`; with `--no-interactive`, pick one with `--event`.

Try the other commands from this directory. Add `--no-interactive` to any of them for plain output.

```bash
pnpm run ci lint                                  # one job
pnpm run ci build --input '{"target":"web"}'      # a job with input
pnpm run ci compat --node 22                      # one matrix combination
pnpm run ci compat                                # every combination
pnpm run ci pr --event pull_request.synchronize   # pick a trigger
pnpm run ci deploy --data '{"target":"api"}'      # a manual trigger
pnpm run ci --pipeline release --event push      # skipped: ci.local
```

`release` listens for pushes to `main`, so on another branch it starts no run and `inngest-ci` says so.

## Things to try

1. Run `pnpm run ci pr` again. `base` is cached on `pnpm-lock.yaml`, so its check says `Restored` and no machine starts. The cache lives in `.inngest/ci-cache`.
2. Break a test without committing. Edit `app/src/sum.ts`, then run `pr`. `test` fails with the end of its output on the check.
3. Run `pr` in two terminals at once. `singleton` cancels the first run.
4. Make a test flaky. Add `.env({ FLAKY: "1" })` to the `pnpm test` command in `ci/jobs.ts`, then run `pr`. `app/src/sum.test.ts` fails about half the time, and `.retries(1)` runs the command again. The check shows the attempt count and the failure.
5. Run `pnpm run ci docs` on a change with no documentation. The pipeline returns `ci.skip()` and its check still completes.
6. On `main`, run `pnpm run ci --pipeline release --event push`. The pipeline returns `ci.skip()` because `ci.local` is true, so nothing is released from your machine.

## What each file shows

| File | Look at |
| --- | --- |
| `ci/jobs.ts` `base` | A cached job with a nightly refresh |
| `ci/jobs.ts` `lint`, `test` | `from(base)` starts on a copy of the `base` machine |
| `ci/jobs.ts` `build` | A job that takes input |
| `ci/jobs.ts` `compat` | `ci.matrix`, one job per Node version |
| `ci/jobs.ts` `e2e` | `.background()` and `waitForHttp()` |
| `ci/jobs.ts` `two-machines` | `sandbox()` for a second machine |
| `ci/jobs.ts` `release` | `step.waitForEvent` and `github.rest` |
| `ci/pipelines.ts` `pr` | `singleton`, `changed()`, and `ci.skip()` |
| `ci/pipelines.ts` `release` | `ci.local` to skip a release |
| `ci/pipelines.ts` `deploy` | `ci.manual()` with a typed payload |
| `ci/pipelines.ts` `prerelease` | `github.comment()` with a permission check |

## End-to-end tests

`e2e/` is the integration test for `@inngest/ci`. Each case is a pipeline that runs on real Sandboxes against a throwaway git repository, and `e2e/run.ts` checks what it returned.

```bash
INNGEST_DEV=1 pnpm ci:e2e
INNGEST_DEV=1 pnpm ci:e2e commands matrix
```

It needs a Dev Server (`npx inngest-cli@latest dev`). It serves its own functions on port 3940.

## Run on GitHub

1. Set up a GitHub App as described in the [package README](../../packages/ci/README.md#run-on-github).
2. Set the app's credentials, then run a pull request. `ci/client.ts` reads them.

```bash
export GITHUB_APP_ID=...
export GITHUB_APP_PRIVATE_KEY="$(cat key.pem)"
export INNGEST_CI_GITHUB=live
pnpm run ci pr
```

To receive real webhooks locally, forward them to the Dev Server:

```bash
INNGEST_DEV=1 pnpm ci:forward
gh extension install cli/gh-webhook
gh webhook forward --repo=owner/name --events='*' --url=http://localhost:3950 --secret="$GITHUB_WEBHOOK_SECRET"
```

Set `GITHUB_WEBHOOK_SECRET` to the secret GitHub signs with. The forwarder verifies `X-Hub-Signature-256`, refuses to start without it, and listens on `127.0.0.1:3950` (override the port with `FORWARDER_PORT`).
