---
"inngest": patch
---

Experimental: you can now run TypeScript in a sandbox with `step.sandbox.typescript`, available with `sandboxMiddleware()`. `input` keys become variables, a top-level `return` gives the result back, and top-level `await` works. It takes the same `schema.output` as `step.sandbox.python` to validate and type the result. The sandbox image needs Node 22.13 or later.

```ts
const total = await step.sandbox.typescript(
  "sum",
  `return numbers.reduce((a: number, b: number) => a + b, 0)`,
  { input: { numbers: [1, 2, 3] } },
);
```
