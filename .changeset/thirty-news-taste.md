---
"inngest": patch
---

`getAsyncCtx()` now correctly finds context when called within:
- `step.run()` calls
- Middleware hooks
