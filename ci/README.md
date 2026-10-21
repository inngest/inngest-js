# inngest-js CI

The pull request checks for inngest-js as `@inngest/ci` pipelines, run by Inngest on Sandboxes. Every job shows up as a check from a GitHub App, with a summary, the failing line, and "Re-run, no cache" and Cancel buttons.

## How it works

GitHub posts `pull_request`, `push`, `check_run` and `check_suite` webhooks to an Inngest Cloud webhook. Its transform (`webhook-transform.js`) turns each delivery into the event the pipelines trigger on, with the App's installation in `_github.installationId`. The pipelines are served from Vercel at `/api/inngest`.

- `client.ts`: the Inngest app, and the GitHub provider.
- `pipelines/pr.ts`, `jobs/`: the checks.
- `webhook-transform.js`: pasted into the Inngest webhook. Tested against real payloads in `fixtures/`.
- `api/inngest.ts`, `vercel.json`: the Vercel endpoint. `server.ts` serves the same app locally for `inngest-ci`.

```ts
export const ci = createCi(inngest, { github: githubApp() });
```

`githubApp()` reads `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, and finds the installation of a repository when an event doesn't carry one.

## Jobs

`jobs/base.ts` is the image every job starts from. It installs the dependencies and the Dev Server, and returns the Dev Server as a command. Jobs that need one run their tests through `runWithDevServer`, which starts it in the background, waits until it answers, then runs the tests:

```ts
export const integration = ci.job(
  { id: "integration", from: build, matrix: { axes: { shard: ["1/6", "2/6"] } } },
  async ({ matrix, from }) => {
    await checkout();

    await runWithDevServer(from, from.$.integration.env({ SHARD: matrix.shard }));
  },
);
```

The test harness reuses a Dev Server that is already listening, so nothing downloads one at test time.

## Set up

### 1. Create the GitHub App

GitHub, Settings, Developer settings, GitHub Apps, New GitHub App. Repository permissions: Checks read and write, Contents read, Pull requests read. Events: Pull request, Push, Check run, Check suite. Webhook URL: the one from step 2. Install it on `inngest/inngest-js`. Keep the App ID and a generated private key for step 3.

### 2. Create the Inngest webhook

Inngest Cloud, the environment that will run CI, Manage, Webhooks, Create webhook. Paste the contents of `webhook-transform.js` into the transform box and save. Copy the webhook URL into the App's webhook settings.

### 3. Deploy to Vercel

In Inngest's Vercel account, add a project from the `inngest/inngest-js` repository.

- Root Directory: `ci`. Enable "Include source files outside of the Root Directory". `vercel.json` sets the install command (it builds `inngest` and `@inngest/ci` from the repository first), `maxDuration` 300 and no framework.
- Node.js 22 or later.
- Environment variables:

| Variable | Value |
| --- | --- |
| `INNGEST_SIGNING_KEY` | The signing key of the Inngest environment. Also authorizes Sandboxes. |
| `INNGEST_EVENT_KEY` | The environment's event key. |
| `INNGEST_ENV` | The environment's slug, so check links open the right runs. |
| `GITHUB_APP_ID` | The App's ID. |
| `GITHUB_APP_PRIVATE_KEY` | The App's private key, on one line with `\n` for newlines. |

Deploy, then in Inngest Cloud go to Apps, Sync new app, and enter `https://<project>.vercel.app/api/inngest`. The app `inngest-js-ci` and its functions should appear. Stop any local worker first, so only one host serves the app.

Sandboxes must be enabled for the environment. Pushes to main keep the cached images warm for pull requests, so the first run is slow.

## Try it locally first

Run the app as a Connect worker against the Inngest Cloud environment instead of Vercel. Events from the webhook reach the worker on this machine.

Put the five variables above and `INNGEST_CI_GITHUB=live` in `~/.config/inngest-ci-dogfood.env` (mode 600), then:

```sh
cd ci
pnpm ci:connect
```

The worker logs `Connected 8 functions ACTIVE`. Stop it with Ctrl+C: it drains in-flight runs and disconnects, and events sent while it is down wait for the next connection.
