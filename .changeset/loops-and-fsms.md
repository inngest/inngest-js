---
"inngest": minor
---

Add experimental `createLoop` and `createFSM` to `inngest/experimental`.  A loop is a function with one state record per key.  Each input for a key is one run, and the handler changes `state` in place.  A run can ask for a later run with `loop.wake()`, end the instance with `loop.end()`, and a loop can subscribe to events with `loop.subscribe()`.  The SDK now sends the `loop` capability at sync.
