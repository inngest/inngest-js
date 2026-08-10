---
"inngest": minor
---

Add experimental `aiMiddleware()`, a single bundle that enables scoring (`step.score()`), metadata (`step.metadata()`), and extended traces (`ctx.tracer`) together. Spread it to compose with your own middleware, or pass `traces: { behaviour: "off" }` to leave your OpenTelemetry provider untouched.
