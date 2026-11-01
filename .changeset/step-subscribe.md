---
"inngest": minor
---

Add experimental `step.subscribe()` and `Inbox`. `step.subscribe(id, sources)` opens an inbox inside a run: every event that matches one of the sources and arrives afterwards becomes a message the run can read in order with `inbox.next()`, whether or not the run is waiting at that moment.
