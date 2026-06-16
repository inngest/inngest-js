# @inngest/otel

OpenTelemetry instrumentation helpers for Inngest.

Use this package when you want a turnkey Node OpenTelemetry setup for Inngest. It
installs the supported instrumentation before app code starts.

This isn't the only supported way to use Inngest with OpenTelemetry. It's also
valid to configure OpenTelemetry yourself when you need direct control over
providers, exporters, sampling, resources, or instrumentation lists.

## Usage

The supported public entrypoint is `@inngest/otel/node`.

The recommended preload path is the Node `--import` flag:

```sh
node --import @inngest/otel/node ./app.js
```

Use `--import` whenever possible. It loads instrumentation before your app,
including CommonJS entrypoints.

If `--import` isn't an option, use a small bootstrap file that loads
instrumentation before loading your app:

```ts
import "@inngest/otel/node";
await import("./app.js");
```
