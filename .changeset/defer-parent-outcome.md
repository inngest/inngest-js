---
"inngest": minor
---

Deferred functions can now see how their parent run ended. `ctx.parents[0]` in a `createDefer` handler gains `status` (`"Completed" | "Failed" | "Cancelled"`), `error` (`{ name, message, stack? }`, set when the parent failed) and `endedAt` (a `Date`), so a handler can branch on parent success or failure without casts. Requires an Inngest server that reports parent outcomes; against older servers these fields are `undefined`.
