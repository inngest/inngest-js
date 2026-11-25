---
"@inngest/test": patch
---

Fix `t.executeStep()` for a step that isn't the first in a parallel group. The engine only recognised the target step when it was listed first, so a step running alongside an earlier `step.sleep()` or `step.waitForEvent()` never resolved, and other parallel steps ran twice before the target was found. Steps are now matched wherever they appear in the list.
