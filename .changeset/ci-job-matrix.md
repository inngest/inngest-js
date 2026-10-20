---
"@inngest/ci": minor
---

`ci.matrix()` is removed; use `ci.job({ matrix })`. It takes the same options (`exclude`, `include`, `failFast`, and `maxParallel`, which was `concurrency`).

```ts
// before
ci.matrix({ id: "compat", axes: { node: ["20", "22"] } }, async ({ matrix }) => {});

// after
ci.job({ id: "compat", matrix: { node: ["20", "22"] } }, async ({ matrix }) => {});
```
