---
"inngest": minor
---

Add `signalId` to sandbox `processes.start()`. When set, the platform sends that signal when the process ends, so a run can wait with `step.waitForSignal()` instead of polling the process.
