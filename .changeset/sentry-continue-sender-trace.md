---
"@inngest/middleware-sentry": minor
---

Propagate active Sentry trace context (`sentry-trace` and `baggage`) onto outgoing events in `transformSendEvent` and `transformStepInput`, and continue the sender's trace in `wrapRequest` when present (configurable via `continueSenderTrace`).
