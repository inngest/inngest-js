---
"inngest": patch
---

Durable endpoints now use the `checkpointing.bufferedSteps` option set on the client or function, so their steps can be checkpointed in batches instead of one round trip per step.
