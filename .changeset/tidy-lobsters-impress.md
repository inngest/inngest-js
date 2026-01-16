---
"inngest": patch
---

Fixed `NonRetriableError` and `RetryAfterError` not being recognized in monorepo 
setups where different packages load separate instances of the Inngest module. 
Both error types now use `instanceof` checks with a fallback to name-based 
detection for reliable cross-package error handling.
