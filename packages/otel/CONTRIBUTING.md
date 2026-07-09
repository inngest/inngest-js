# Contributing to @inngest/otel

## OpenTelemetry dependency invariant

`@inngest/otel` must resolve exactly one version of every `@opentelemetry/*` package in its production dependency graph. Multiple OpenTelemetry versions can break instrumentation registration and context propagation in ways that are hard to diagnose.

When changing OpenTelemetry, Traceloop, or auto-instrumentation dependencies, verify that the resulting lockfile still resolves one version per `@opentelemetry/*` package for `@inngest/otel`.
