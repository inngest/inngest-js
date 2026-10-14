---
"inngest": patch
---

Experimental: you can now run TypeScript in a sandbox with `step.sandbox.typescript`, available with `sandboxMiddleware()`. `input` keys become variables, a top-level `return` gives the result back, and top-level `await` works. A sandbox you created has the same `sandbox.typescript(id, code, options)`. The sandbox image needs Node 22.13 or later.

```ts
const total = await step.sandbox.typescript(
  "sum",
  `return numbers.reduce((a: number, b: number) => a + b, 0)`,
  { input: { numbers: [1, 2, 3] } },
);
```
