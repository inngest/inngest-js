---
"inngest": minor
---

Sandboxes can now be scoped with `await using`; they're destroyed when the block exits.

```ts
await using sb = await step.sandbox.create("build");
await sb.commands.run("npm test");
```
