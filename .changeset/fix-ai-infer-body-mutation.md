---
"inngest": patch
---

Prevent `step.ai.infer` from writing adapter defaults into the caller's request body, so each step can use its own model when steps reuse the same body.
