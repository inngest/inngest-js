---
"inngest": patch
---

Fix failing to parse `BigInt` during step/function result serialization; it is now correctly typed and returned as `never`
