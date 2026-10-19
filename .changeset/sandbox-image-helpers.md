---
"inngest": minor
---

Choose the image a sandbox starts from with `image.inngest()` or `image.custom()`, exported from `inngest/experimental`.

```ts
import { image } from "inngest/experimental";

await step.sandbox.create("build", { from: image.inngest("base") });
await step.sandbox.create("custom", { from: image.custom("my-image:v1") });
```
