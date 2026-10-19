---
"@inngest/ci": minor
---

Concurrent runs that miss the same cached job now build it once and share the result, instead of each building their own. Needs `inngest` 4.24.1 or later.
