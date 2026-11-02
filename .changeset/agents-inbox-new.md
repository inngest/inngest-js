---
"inngest": minor
---

**Breaking (experimental agents):** an agent's `inbox` is now the `Inbox` of `step.subscribe()`. The event that started the run is still its first message, and the `inbox` config adds its sources with `listen`. `next()` returns `undefined` once the inbox is closed, and with a `timeout` returns `null` when none arrives in time (it was the other way round). `unread()` is `drain()`, `nextBatch()` and `batches()` read batches, and `listen()` returns the view at once instead of a promise. `putBack()`, `current()`, `message.seq` and `next({ timeout: 0 })` are gone; `inbox_read` of the inbox tools no longer takes `all`. Name loop steps by `message.id` where you used `message.seq`. The old numbered subscription (`step.subscribeLegacy()`, `step.inbox()`) and its types (`Subscription`, `SubscribeOptions`, `SubscribeEvent`, `SubscribeData`, `SubscribeMessages`, `SubscribeTool`, `ExactOptions`, `NamedOptions`) are removed.
