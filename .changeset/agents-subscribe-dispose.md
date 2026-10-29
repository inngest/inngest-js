---
"inngest": minor
---

A `step.subscribe()` subscription closes itself when its scope ends. Await it and declare it with `await using`, and it closes even if you forget to: `await using inbox = await step.subscribe("inbox", { event: "msg" })`. `close()` is still there. It only ends the subscription: it does not touch the run or the function's singleton, and it returns the messages that were saved but not read. Calling it twice does nothing. `await using` needs TypeScript 5.2 or later; the dispose symbol is filled in on Node before 20.5.

A subscription is cheaper. Each message is saved as a step named after the subscription and the event, and nothing else happens when it is saved. The k-th `next()` returns the k-th message of the run's steps, so reading a message that has already arrived costs no step. When there is none the request ends with the read still waiting, like a pending `step.waitForEvent()`, and every message the executor saves gives the run a discovery so the function can see it. The executor does not know whether the function is waiting; a function with nothing to do with the message waits again, and messages that arrive in a burst while a discovery is queued or running share it. A subscription costs one step to open and one to close each event and one per `poll()`; a read that waits costs no step. The same event delivered twice is one message. `ack()` is gone: nothing used it once the run-end re-send was removed.

A message is the event it was made from, flat, with its position: `{ seq, id, name, data, ts, user }` (and `v` when the event has one), typed by the event type when you subscribe with one. Read `msg.name`, `msg.data.total` and `msg.seq`; checking `msg.name` narrows `msg.data` for a subscription to several event types. Runs that started before this still replay: a memo that holds `{ seq, data: event }` is read as the event.

Every message has the `name` of its event. The options are checked for typos: `{ event, iff }` is a compile error instead of a filter that is silently dropped. An explicit message type, `step.subscribe<MyData>(...)`, is accepted only for events named by a string; with an event type the message data comes from the type. A `next()` that is waiting still takes its message even if you stop awaiting it, so do not race `next()` in a plain `Promise.race`. `close()` ends a wait that is still open.

Nothing is re-sent when a run ends. A message that arrives after the inbox closes, while the thread's singleton still applies, is dropped: it starts no new run and does not reach the finished one. The gap is the time between the body returning and the run ending. An agent's inbox closes when its body returns, and the messages it saved but the body never read are discarded.

`thread.stop({ when: "now" })` now cancels the thread's live run by its run ID through the Inngest API, so it works for any thread key, including a computed one. It needs the API reachable from where you call it (your signing key, or the Dev Server).

`thread.stop()` now returns `{ stopped }`: `"now"` answers `{ stopped: false }` when the thread has no record or no live run, instead of doing nothing silently, and throws when the cancel fails.

Removed from `inngest/experimental/agents`: the `agentStop` event type, `agentStopEvent` and the `ThreadStop` type (nothing sends or listens for a stop event any more), `Subscription.ack()` and `InboxMessage.source`.

`inbox.next({ timeout })` stops waiting after the timeout, like `step.waitForEvent()`: it returns `undefined`, the run goes on, and a message sent later is read by the next call. A timeout that expired stays expired when the run replays. The options of a subscription and of each event in `events` are checked for unknown fields.

`null` is only the end of a subscription that `close()` or a limit ended.

A subscription needs a Dev Server or backend that has the matching `step.subscribe` support (the OSS `step-subscribe` change). `next({ timeout })` waits with a `step.sleep()`; while a subscription is open the function plans steps before running them, so a message that arrives while a step runs cannot run the step twice. `InboxMessage.user` is optional, because messages saved before it was kept do not have it.

An agent body's `inbox.next({ timeout })` takes the same timeout and returns `undefined` when it expires, so a body can wait for a message for a while without racing `next()` against a sleep.
