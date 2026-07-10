# @inngest/otel behavior and support

This document defines the supported public behavior for `@inngest/otel`. User-facing setup examples live in the package [README](../README.md).

## Supported usage

The supported public entrypoint is `@inngest/otel/node`, which resolves to `node.mjs` for ESM imports and `node.cjs` for CommonJS requires. The concrete `@inngest/otel/node.mjs` and `@inngest/otel/node.cjs` subpaths are also supported.

The package doesn't expose a root `@inngest/otel` export.

## Runtime behavior

When `@inngest/otel/node` is preloaded, it:

- Registers the OpenTelemetry ESM instrumentation hook for ESM preloads
- Registers supported Node auto-instrumentations
- Registers Traceloop OpenAI instrumentation
- Registers Anthropic instrumentation
- Registers Google Generative AI instrumentation for `@google/genai` v1
- Ensures there's a process-global OpenTelemetry tracer provider
- Installs an async hooks context manager when this package creates the provider
- Doesn't install Inngest span processors or exporters
- No-ops when loaded more than once in the same process

If an OpenTelemetry tracer provider already exists, this package leaves it in place. If no provider exists, this package creates a basic provider.

Users cannot set their own processors at provider construction time.

The main `inngest` package is responsible for adding Inngest span processors.

`@inngest/otel/node` should run as a Node preload before the application entrypoint imports application code or instrumented libraries. Libraries imported before the preload runs may not be instrumented.

This package isn't the only supported way to use Inngest with OpenTelemetry. Apps can configure OpenTelemetry themselves when they need direct control over providers, exporters, sampling, resources, or instrumentation lists.

## Supported environments

This package currently supports:

- Node.js 20 and newer
- ESM preload through `node --import` for ESM and CommonJS application entrypoints
- CommonJS preload through `node --require` for CommonJS module loading

## Not supported

This package doesn't currently support:

- `import "@inngest/otel"`
- Browser, edge, worker, or non-Node runtimes
- Configuration of processors, exporters, sampling, resources, or instrumentation lists
- `@google/genai` v2 instrumentation through Traceloop's Google Generative AI instrumentation

Applications that already configure OpenTelemetry can continue to own that setup instead of using this package.

## Compatibility expectations

The supported public API is the `@inngest/otel/node` preload path. Internal files and helper functions aren't public API.

Future runtime-specific entrypoints should be added as explicit subpath exports. Don't add a root export unless there's a stable, documented root-level API that users should import directly.
