---
"@inngest/middleware-sentry": major
---

Support TypeScript SDK v4

### Breaking changes

- Requires `inngest` v4.
- The `SentryMiddleware` export type has been removed. The `sentryMiddleware()` function now returns `Middleware.Class` directly.
- The `inngest.function.name` tag is no longer set (v4's `FunctionInfo` only exposes `id`). Use `inngest.function.id` instead.
- The Sentry transaction name now uses the function ID (`inngest:<function-id>`) instead of the function name (`inngest:<function-name>`).
