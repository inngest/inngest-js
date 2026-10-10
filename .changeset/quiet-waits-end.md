---
"inngest": patch
---

Fix a returning handler not always ending the run. When the handler returns during a discovery request, any steps it left unawaited (e.g. a floating `step.waitForEvent()`, `step.sleep()`, or `step.run()`) are now reported alongside `RunComplete` instead of replacing it, so they no longer keep the run open until they resolve. A targeted step request now runs the requested step and returns its result even if the handler returns first, rather than completing the run with that step left queued.

For default (optimized parallelism) users the one visible change is in `group.parallel({ mode: "race" })`: losers still running when the handler returns are now cancelled when the run ends, rather than the run staying open until they finish.
