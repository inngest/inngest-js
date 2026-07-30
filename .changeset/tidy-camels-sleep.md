---
"inngest": patch
---

Sub-second durations no longer get dropped. `step.sleep("id", 500)` used to resolve immediately; it now rounds up and sleeps a full second, the minimum resolution of a durable wait. The same rounding applies to `waitForEvent`, `invoke`, `waitForSignal`, and `cancelOn` timeouts.
