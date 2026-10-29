---
"inngest": minor
---

An agent can drop a thread sandbox in the middle of a run and get it back. `sandboxes.work.recycle()` saves the sandbox and destroys it; the next `get()` or tool call restores a new sandbox from that snapshot, files and all, so an idle thread doesn't have to hold a sandbox until its run ends.

```ts
await sandboxes.work.recycle();
// later, in the same run
const work = await sandboxes.work.get(); // restored from the snapshot
```

Each save is a later generation of the run, and the thread's next run restores the newest. Call it when nothing is running in the sandbox; a command still in progress is lost.
