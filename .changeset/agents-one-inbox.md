---
"inngest": minor
---

An agent's `inbox` is one `step.subscribe()` inbox with one reader, so `inbox.of()`, `inbox.listen()` and `ThreadListener` are removed. The model's inbox tools are now `inbox_listen`, `inbox_next`, `inbox_next_batch` and `inbox_close`: `inbox_listen` opens a named inbox, and the other three read or close it by `as` (without `as`, the agent's own inbox). In a definition source's `if`, `event` now means the run's trigger; use `async` for the arriving event.
