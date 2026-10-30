---
"inngest": minor
---

Experimental agents: `report.status()`, `report.card()` and `report.begin()` are best effort. They return at once instead of waiting for the write, the write runs as a step nobody waits for, and a failure (Slack's `message_not_found`, a timeout) is logged and leaves the step complete, so a progress update can no longer slow down or fail a run. `report.finish()` and the plain `report()` post are still awaited and still surface their errors; `finish()` queues after the writes before it. The run waits for writes still in flight before it ends, and `report.settled()` does the same on demand.
