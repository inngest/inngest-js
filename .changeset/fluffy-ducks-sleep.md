---
"inngest": minor
---

Bump minimum `@opentelemetry/auto-instrumentations-node` to `0.75.0` to address
[GHSA-q7rr-3cgh-j5r3](https://github.com/advisories/GHSA-q7rr-3cgh-j5r3) in the
transitive `@opentelemetry/sdk-node` / `@opentelemetry/exporter-prometheus` packages.

Note that upstream `auto-instrumentations-node@0.72.0` dropped bundled Fastify,
instrumentation, so if you relied on it for tracing your Fastify routes, add
`@opentelemetry/instrumentation-fastify` directly.
