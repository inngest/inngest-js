# inngest-js CI

The pull request checks for inngest-js as `@inngest/ci` pipelines, run by Inngest on Sandboxes.

## How it works

GitHub posts `pull_request` and `push` webhooks to an Inngest Cloud webhook. Its transform (`webhook-transform.js`) turns each delivery into the event the pipelines trigger on. The pipelines are served from Vercel at `/api/inngest`. Before anything runs, the run asks GitHub whether the event is true, and results are written back as commit statuses.

- `client.ts`: the Inngest app, the GitHub provider (`githubToken()`), and `verifyEvents: true`.
- `pipelines/pr.ts`, `jobs/`: the checks.
- `webhook-transform.js`: pasted into the Inngest webhook. Tested against real payloads in `fixtures/`.
- `api/inngest.ts`, `vercel.json`: the Vercel endpoint. `server.ts` serves the same app locally for `inngest-ci`.

Inngest webhooks don't verify GitHub's signature, so `verifyEvents` is what keeps a forged event from running:

- A pull request event must name a pull request that exists, with the head commit the event says.
- A push event must name a commit that is the tip of its ref or an ancestor of it.
- A repository the token can't see counts as not found.
- A rejected event fails the run without retrying, before any status or sandbox. Cache refreshes on pushes to main are verified the same way.

## Set up

### 1. Create the token

GitHub, Settings, Developer settings, Fine-grained personal access tokens, Generate new token.

- Resource owner: `inngest`. Repository access: only `inngest/inngest-js`.
- Permissions: Commit statuses: Read and write. Contents: Read. Pull requests: Read. Metadata: Read.

Keep it for step 4 as `GITHUB_TOKEN`.

### 2. Create the Inngest webhook

Inngest Cloud, the environment that will run CI, Manage, Webhooks, Create webhook. Paste the contents of `webhook-transform.js` into the transform box and save. Copy the webhook URL.

### 3. Add the GitHub webhook

`inngest/inngest-js`, Settings, Webhooks, Add webhook.

- Payload URL: the webhook URL from step 2.
- Content type: `application/json`.
- Secret: leave empty (Inngest doesn't check it).
- Events: "Let me select individual events", then Pull requests and Pushes only.

### 4. Deploy to Vercel

In Inngest's Vercel account, add a project from the `inngest/inngest-js` repository.

- Root Directory: `ci`. Enable "Include source files outside of the Root Directory". `vercel.json` sets the install command (it builds `inngest` and `@inngest/ci` from the repository first), `maxDuration` 300 and no framework.
- Node.js 22 or later.
- Environment variables:

| Variable | Value |
| --- | --- |
| `INNGEST_SIGNING_KEY` | The signing key of the Inngest environment. Also authorizes Sandboxes. |
| `INNGEST_EVENT_KEY` | The environment's event key. |
| `GITHUB_TOKEN` | The token from step 1. |
| `INNGEST_ENV` | The environment's slug, so check links open the right runs. |
| `INNGEST_CI_GITHUB` | `live` |

Deploy, then in Inngest Cloud go to Apps, Sync new app, and enter `https://<project>.vercel.app/api/inngest`. The app `inngest-js-ci` and its functions should appear.

Sandboxes must be enabled for the environment. The first pull request builds the cached images, so warm them by merging to main or expect the first run to be slow.

### 5. Try it safely

Open a draft pull request on inngest-js. The `pr` and `pr / ...` statuses appear on the commit and the Inngest run is linked from them. They are not in the branch ruleset, so a failure blocks nothing, and the GitHub Actions checks stay the required ones. To test verification, replay a delivery from the GitHub webhook page after pushing a newer commit: the run fails with "Event rejected" and posts nothing.

## Try it locally first

Run the app as a Connect worker against the Inngest Cloud environment instead of Vercel. Events from the GitHub webhook reach the worker on this machine, and statuses are written to GitHub for real.

Put `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`, `INNGEST_ENV`, `GITHUB_TOKEN` and `INNGEST_CI_GITHUB=live` in `~/.config/inngest-ci-dogfood.env` (mode 600), then:

```sh
cd ci
pnpm ci:connect
```

The worker logs `Connected 8 functions ACTIVE` and the app `inngest-js-ci` shows its functions in Inngest Cloud. Sandboxes run in Cloud, authorized by the signing key.

- Open a draft pull request on inngest-js. The `pr` and `pr / <job>` commit statuses appear and link to the Inngest runs.
- Replay an old delivery from the GitHub webhook page after pushing a newer commit: the run fails with "Event rejected" and posts nothing.
- Stop the worker with Ctrl+C. It drains in-flight runs and disconnects; events sent while it is down wait for the next connection.

## Switching to a GitHub App later

Create the App (Checks read and write, Contents read, Pull requests read; events Pull request, Push, Check run, Check suite), install it on `inngest/inngest-js`, and set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. In `client.ts` replace `githubToken()` with `githubApp({ appId, privateKey })` and drop `GITHUB_TOKEN`. Checks then appear with summaries and annotations.
