---
"inngest": minor
---

Deprecate `optimizeParallelism: false` — use `group.parallel({ mode: "race" })` for race semantics instead. Fixes runs with parallel steps permanently losing checkpointing after a `Promise.all`.
