---
"@inngest/ci": patch
---

Pipelines can now check every pull request and push event against GitHub before they run, so a forged webhook can't start one. Turn it on with `createCi(inngest, { verifyEvents: true })`; an event GitHub doesn't agree with fails the run without retrying.
