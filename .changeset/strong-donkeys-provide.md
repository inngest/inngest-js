---
"@inngest/middleware-encryption": patch
"@inngest/middleware-sentry": patch
"@inngest/middleware-validation": patch
"@inngest/realtime": patch
"@inngest/test": patch
---

Bump `inngest` dependency to `^3.42.0`

This version changed a lot of `Inngest*.Like` types to future-proof them against updates.
Before this, all updates caused typing issues when we upgraded, but following this patch we shouldn't see that issue again.
