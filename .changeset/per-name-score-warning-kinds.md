---
"inngest": minor
---

Write scores as one `inngest.score.<name>` metadata kind per score name (values `{ value }`) and SDK warnings as one `inngest.warning.<code>` kind per warning code, both sent as `set`.

`score.experiment()` no longer accepts `stepId`. Experiment scores must be run-scoped, which the REST API already enforces.

Requires an Inngest server (self-hosted or dev server) that accepts per-name score and warning kinds (inngest/inngest#4992). Older servers reject these kinds when they're sent via the API (with a 400) or with a checkpointed step, so those scores and warnings are lost.
