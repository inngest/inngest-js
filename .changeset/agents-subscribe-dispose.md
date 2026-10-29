---
"inngest": minor
---

A `step.subscribe()` subscription closes itself when its scope ends. Await it and declare it with `await using`, and it closes even if you forget to: `await using inbox = await step.subscribe("inbox", { event: "msg" })`. `close()` is still there. It only ends the subscription: it does not touch the run or the function's singleton, and it returns the messages that were saved but not read. Calling it twice does nothing. `await using` needs TypeScript 5.2 or later; the dispose symbol is filled in on Node before 20.5.

A subscription is cheaper. Each message is saved as a step named after the subscription and the event, and nothing else happens when it is saved. The k-th `next()` returns the k-th message of the run's steps, so reading a message that has already arrived costs no step. When there is none the function parks: the executor records a marker, and a message arriving wakes only a parked run, so a busy run never gets a wake it does not need. A subscription costs one step to open and one to close each event, one park whenever the function had to wait, and one per `poll()`. The same event delivered twice is one message. `ack()` is gone: nothing used it once the run-end re-send was removed.

A `next()` that is waiting still takes its message even if you stop awaiting it, so do not race `next()` in a plain `Promise.race`. `close()` ends a wait that is still open.

Nothing is re-sent when a run ends. A message that arrives after the inbox closes, while the thread's singleton still applies, is dropped: it starts no new run and does not reach the finished one. The gap is the time between the body returning and the run ending. An agent's inbox closes when its body returns, and the messages it saved but the body never read are discarded.

`thread.stop({ when: "now" })` now cancels the thread's live run by its run ID through the Inngest API, so it works for any thread key, including a computed one. It needs the API reachable from where you call it (your signing key, or the Dev Server).

`thread.stop()` now returns `{ stopped }`: `"now"` answers `{ stopped: false }` when the thread has no record or no live run, instead of doing nothing silently, and throws when the cancel fails.

Removed from `inngest/experimental/agents`: the `agentStop` event type, `agentStopEvent` and the `ThreadStop` type (nothing sends or listens for a stop event any more), `Subscription.ack()` and `InboxMessage.source`.
