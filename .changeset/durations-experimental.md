---
"inngest": minor
---

Export `durationToMs()` and the `DurationInput` type from `inngest/experimental`: one helper that turns a number of milliseconds, an `ms` string (including compound forms like `"1h30m"`) or a `Temporal.Duration` into milliseconds. Sandbox durations (`runningTimeout`, `timeout`) use it, so they now also accept compound strings.
