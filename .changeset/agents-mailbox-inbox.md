---
"inngest": minor
---

An inbox can take event sources beyond the ones that start the agent. `agents.agent({ on, inbox: [{ event, thread: "event.data.t" }] })` lists live-only sources: their events reach the run of the thread they map to while it is live and never start one. `inbox.listen(source, { thread })` adds a source mid-run and returns a listener whose `stop()` (or `await using`) removes it; its messages join the inbox in order. `step.inbox(id, { sources? })` makes another inbox with a sequence of its own.

Reading an inbox: `next()` waits and advances the reader's cursor (`next({ timeout })` gives up with `undefined`, `next({ timeout: 0 })` never waits), `unread()` takes everything after the cursor without waiting, and `current()` lists every message so far without moving the cursor. `poll()` is gone: use `next({ timeout: 0 })` for one message or `unread()` for all that are pending; `ThreadInbox.drain()` is now `unread()`.

Step IDs of a subscription's open and close now carry the stream number (`<id>:0:open`); runs that began with the old IDs keep replaying them.
