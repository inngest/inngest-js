---
"@inngest/ci": minor
---

CI runs are now grouped into Inngest Sessions by pull request, commit, pipeline run and image, so you can open one in the dashboard and see every run behind it. Paste the updated `githubWebhookTransform` into your webhook to get the `pull_request` and `commit` sessions.
