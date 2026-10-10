---
"inngest": patch
---

Fix a returning handler not always ending the run. When the handler returns during a discovery request, the run now completes: unawaited steps that are still unreported at that point (e.g. a floating `step.waitForEvent()`, `step.sleep()` or `step.run()`, or the losers of a race) are not scheduled, instead of being reported in place of the completion and keeping the run open until they resolve. A targeted step request now runs the requested step and returns its result even if the handler returns first, rather than completing the run with that step left queued.

For default (optimized parallelism) users the one visible change is in `group.parallel({ mode: "race" })`: losers still running when the handler returns are cancelled when the run ends, rather than the run staying open until they finish.
