---
"inngest": minor
---

Experimental: your `connect()` worker can now run as a Live Tap. Started with `inngest tap`, it takes real traffic for the functions you pick, can run in shadow mode, and hands anything it does not want back to production without spending a retry. You can also pull a recorded run to replay it on your current code with a step-by-step diff, or generate an `@inngest/test` scaffold and fixture from it.

`connect()` also accepts an experimental `start` function that provides the connection session, so a worker without a signing key can connect.

```ts
await connect({
  apps: [{ client }],
  start: async () => mintSessionOnTheHost(),
});
```
