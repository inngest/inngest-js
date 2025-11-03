---
"inngest": patch
---

Fix custom loggers dumbly waiting 1s to flush; they now correctly call `flush()` if available
