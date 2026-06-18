---
"inngest": minor
---

Add `sessions` to event payloads

Pass `sessions: { [sessionKey]: sessionId }` when sending events (`inngest.send()`, `step.sendEvent()`, `EventType.create()`) to group the runs they trigger into named sessions

- `step.invoke()` accepts an explicit `sessions` option
- `step.waitForEvent()` results carry the matched event's `sessions`
- Lifecycle events (`inngest/function.finished`, `.failed`, `.cancelled`) carry the sessions of the event they report on, so `onFailure` handlers stay in the same sessions
