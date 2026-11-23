---
"@inngest/test": patch
---

Mock `step.sendEvent` in `InngestTestEngine` (via the default `mockCtx`) so the call is recorded and resolves locally instead of proxying to the real Inngest client, which previously failed inside tests (e.g. with a 401 or a missing event key).
