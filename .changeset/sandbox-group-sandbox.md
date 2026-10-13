---
"inngest": minor
---

Experimental: `group.sandbox()` runs a callback with a fresh sandbox and destroys it afterwards. The sandbox's whole lifetime shows as one group in the trace, and a retried failure keeps the sandbox for the next attempt.

```ts
await group.sandbox("build", async (sb) => {
  await sb.commands.run("npm test");
});
```
