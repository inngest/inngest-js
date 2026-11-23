---
"@inngest/test": patch
---

Fix memory growth in long test files. Step spies are no longer kept in module-level sets, so each `execute()` can be garbage collected once the test is done with it.
