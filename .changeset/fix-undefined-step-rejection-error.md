---
"inngest": patch
---

Fix steps that reject with `undefined` (or other falsy values) dropping their serialized error, `StepFailed` data, and `x-inngest-no-retry` header.
