---
"inngest": minor
---

Added an experimental `inngest.globals()`, which returns a typed `step` and `group` you can import anywhere instead of passing them around. They include sandbox, fetch and middleware-added tools.

```ts
// inngest.ts
export const { step, group } = inngest.globals();

// helper.ts
import { step } from "./inngest";

export const build = () => step.sandbox.create("box");
```
