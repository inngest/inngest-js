---
"inngest": patch
---

Keep `score.experiment()` run-scoped when `runId` is omitted inside `step.run()`, and preserve `parent.runId` in `createScorer()` when the handler returns `runId: undefined`.
