---
"inngest": minor
---

No run of an agent in `inngest/experimental/agents` ends silently. Every ending (`completed`, `failed` or `cancelled`, which includes a `timeouts.finish` limit) is kept on the thread as `lastRun`, shown by `thread.state().lastRun` and handed to the next run's body as `previousRun`, with the error of a failure. The executor reports each ending in an `inngest/function.finished` event that carries the status and the error, so each agent gets one more function, `<id>-finished`, that listens for it; `agents.functions()` includes it. (A `defer` also runs after every ending but its event carries no outcome, and `onFailure` sees failures only.)

`recovery: true` (or `{ resume, message }`) is opt-in. For a run that failed unexpectedly the agent posts one line to its channels (the `report` config) and resends the turn that was in flight, so a fresh run takes it up. A turn that fails with the same error twice (the error with ids and numbers removed, up to three different errors) is not resent and the failure is reported as stuck. Cancelled and completed runs are never resumed. `resume: false` reports without resending; `message` changes the text or returns `false` to stay quiet.

The body also gets `restarts`, the number of times the run has continued in another process (a restart, a deploy, or another instance picking it up), counted at the run's state writes, so a status line can say "resumed after a restart" when it grows.

```ts
agents.agent(
  { id: "bot", recovery: true, channels: { main: slack.channel(event) } },
  async ({ inbox, previousRun, restarts, report }) => {
    if (previousRun?.status === "failed") {
      await report(`The run before this one failed: ${previousRun.error}`);
    }
    // ...
  },
);
```
