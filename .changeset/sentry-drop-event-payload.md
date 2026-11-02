---
"@inngest/middleware-sentry": patch
---

Do not put the full triggering event on Sentry spans by default. Event id and name stay as tags. Pass `includeEventPayload: true` to restore the JSON payload.
