---
"inngest": minor
---

Choose the image a sandbox starts from with `image.inngest()` or `image.custom()`, exported from `inngest/experimental`.

```ts
import { image } from "inngest/experimental";

await step.sandbox.create("build", {
  name: "build",
  vcpu: 2,
  memoryMb: 2048,
  from: image.inngest("base"),
});

await step.sandbox.create("custom", {
  name: "custom",
  vcpu: 2,
  memoryMb: 2048,
  from: image.custom("my-image:v1"),
});
```
