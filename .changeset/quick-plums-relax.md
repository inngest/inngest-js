---
"inngest": patch
---

Fix `step.sleep()` and `step.waitForEvent()` timeout silently dropping sub-second durations (e.g. `500` or `1500` milliseconds), which previously produced an empty/invalid duration string or lost the fractional second. Sub-second durations are now rounded up to the nearest whole second.
