---
"@inngest/ci": minor
---

GitHub events are now named `github-ci/...` instead of `github/...`, like `github-ci/pull_request.synchronize` and `github-ci/push`, so `@inngest/ci` never collides with other `github/*` events in an Inngest environment. `githubEventName()`, `githubWebhookTransform`, every `github.*` trigger, `github.waitForChecks()`, `github.waitForWorkflow()` and the `fixtures` helpers use the new names.

This is a breaking rename with no alias. Anyone with an existing GitHub webhook must replace its transform with the new `githubWebhookTransform` (or edit its event name prefix to `github-ci/`), and anything else that sends or listens for these events must use the new names.
