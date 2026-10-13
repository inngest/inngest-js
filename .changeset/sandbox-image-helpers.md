---
"inngest": minor
---

Choose the image a sandbox starts from with `image.inngest()` or `image.custom()`.

```ts
await step.sandbox.create("build", { from: image.inngest("node") });
await step.sandbox.create("custom", { from: image.custom("registry.example.com/app:1.2") });
```
