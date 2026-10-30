---
"inngest": patch
---

A best-effort `report.status`, `report.card` or `report.begin` write that hangs is now given up on after 10 seconds, so it never holds up `report.finish()` or the end of the run. A plain `report(text)` now lands after the status writes queued before it.
