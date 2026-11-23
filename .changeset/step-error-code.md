---
"inngest": patch
---

Preserve the `code` property on `StepError`. Custom error codes are already kept during serialization but were dropped when wrapping a failed step, so `stepError.code` was always `undefined`.
