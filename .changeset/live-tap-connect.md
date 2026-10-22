---
"inngest": minor
---

Experimental: your `connect()` worker can now run as a Live Tap. Started with `inngest tap`, it takes real traffic for the functions you pick, can run in shadow mode, and hands anything it does not want back to production without spending a retry. You can also pull a recorded run to replay it on your current code with a step-by-step diff (steps the run did not record run for real on your machine), or generate an `@inngest/test` scaffold and fixture from it. Pull reads the v2 run and trace API, whose response shape has not yet been verified against a live server; it fails with a clear message if the shape or the recorded outputs are not what it expects.

`connect()` also accepts an experimental `start` function that provides the connection session, so a worker without a signing key can connect.

```ts
await connect({
  apps: [{ client }],
  start: async () => mintSessionOnTheHost(),
});
```
