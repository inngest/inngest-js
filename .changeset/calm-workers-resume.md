---
"inngest": patch
---

Keep Connect steps that are in flight when the worker thread crashes: the respawned worker thread now extends their leases and sends their replies.
