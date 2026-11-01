---
"inngest": minor
---

Add experimental `step.subscribe()` and `Inbox`. `step.subscribe(id, sources)` opens an inbox inside a run: every event that matches one of the sources and arrives afterwards becomes a message the run can read in order with `inbox.next()`, whether or not the run is waiting at that moment. On an executor that does not support inboxes (an older Dev Server or Cloud), `step.subscribe` fails at once with an error that says what to upgrade instead of leaving a read waiting.
