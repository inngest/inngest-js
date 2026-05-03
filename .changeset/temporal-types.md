---
"inngest": minor
---

Accept `Temporal.Duration`, `Temporal.Instant`, and `Temporal.ZonedDateTime` (and their `*Like` variants) wherever a timeout or sleep duration is taken: `step.sleep()`, `step.waitForEvent()`, `step.waitForSignal()`, `step.invoke()`, and function-level `cancelOn` timeouts. Durations are treated as relative waits; instants and zoned date-times as absolute deadlines.
