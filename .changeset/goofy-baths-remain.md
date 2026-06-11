---
"inngest": minor
---

Deprecate `optimizeParallelism: false` — use `group.parallel({ mode: "race" })` for race semantics instead. Opting out prevents runs from resuming checkpointing after a `Promise.all`.
