# @inngest/otel behavior and support

This document defines the supported public behavior for `@inngest/otel`.
User-facing setup examples live in the package [README](../README.md).

## Supported usage

The supported public entrypoint is `@inngest/otel/node`.

The package doesn't expose a root `@inngest/otel` export.

## Runtime behavior

When `@inngest/otel/node` is preloaded, it:

- registers the OpenTelemetry ESM instrumentation hook
- registers supported Node auto-instrumentations
- registers Anthropic instrumentation
- ensures there's a process-global OpenTelemetry tracer provider
- installs an async hooks context manager when this package creates the provider
- doesn't install Inngest span processors or exporters
- no-ops when loaded more than once in the same process

If an OpenTelemetry tracer provider already exists, this package leaves it in
place. If no provider exists, this package creates a basic provider.

The main `inngest` package is responsible for adding Inngest span processors.
User-managed OpenTelemetry setups can add their own processors and exporters.

Instrumentation should be loaded before application imports. Libraries imported
before the preload runs may not be instrumented.

This package isn't the only supported way to use Inngest with OpenTelemetry.
Apps can configure OpenTelemetry themselves when they need direct control over
providers, exporters, sampling, resources, or instrumentation lists.

## Supported environments

This package currently supports:

- Node.js 20 and newer
- ESM preload through `node --import`
- ESM and CommonJS application entrypoints after the preload

## Not supported

This package doesn't currently support:

- `node --require @inngest/otel/node`
- `require("@inngest/otel/node")`
- `import "@inngest/otel"`
- browser, edge, worker, or non-Node runtimes
- configuration of exporters, sampling, resources, or instrumentation lists

Applications that already configure OpenTelemetry can continue to own that setup
instead of using this package.

## Compatibility expectations

The supported public API is the `@inngest/otel/node` preload path. Internal files
and helper functions aren't public API.

Future runtime-specific entrypoints should be added as explicit subpath exports.
Don't add a root export unless there's a stable, documented root-level API that
users should import directly.
