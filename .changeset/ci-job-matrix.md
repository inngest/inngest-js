---
"@inngest/ci": minor
---

`ci.matrix()` is removed; use `ci.job({ matrix })`, which takes `axes` and the same `exclude`, `include`, `concurrency` and `failFast` options.

```ts
// before
ci.matrix({ id: "compat", axes: { node: ["20", "22"] } }, async ({ matrix }) => {});

// after
ci.job({ id: "compat", matrix: { axes: { node: ["20", "22"] } } }, async ({ matrix }) => {});
```
