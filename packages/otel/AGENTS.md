# Agent Guidance

This package provides the turnkey Node OpenTelemetry setup path for Inngest.

## Package Contract

- Keep `@inngest/otel/node` as the supported public entrypoint.
- Don't add a root `@inngest/otel` export unless there's a stable, documented root-level API users should import directly.
- Keep this package focused on initializing OpenTelemetry instrumentation and a basic provider when needed.
- Don't add Inngest span processors or exporters here. The main `inngest` package owns Inngest span processors, and user-managed OpenTelemetry setups own their own processors and exporters.
- Never allow `@inngest/otel` to install multiple versions of any `@opentelemetry/*` package in its production dependency graph. This is a hard compatibility invariant for instrumentation packages. When changing OpenTelemetry, Traceloop, or auto-instrumentation dependencies, verify that the resulting lockfile still resolves one version per `@opentelemetry/*` package for this package's production dependency graph.

## Docs

- Update `README.md` for user-facing setup and usage guidance.
- Read `CONTRIBUTING.md` before changing OpenTelemetry, Traceloop, or auto-instrumentation dependencies.
- Update `docs/support.md` when changing supported runtime behavior, public entrypoints, unsupported usage, or compatibility expectations.
- Read `docs/support.md` before changing package exports, preload behavior, provider initialization, or supported runtime assumptions.

## Validation

Run these checks after changes:

```sh
pnpm -C packages/otel run type-check
pnpm -C packages/otel run lint
pnpm -C packages/otel run format:check
pnpm -C packages/otel run build
```
