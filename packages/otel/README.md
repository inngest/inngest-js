# @inngest/otel

OpenTelemetry instrumentation helpers for Inngest.

Use this package when you want a turnkey Node OpenTelemetry setup for Inngest. It installs the supported instrumentation before app code starts.

This isn't the only supported way to use Inngest with OpenTelemetry. It's also valid to configure OpenTelemetry yourself when you need direct control over providers, exporters, sampling, resources, or instrumentation lists.

## Instrumentation

This preload registers:

- Common Node.js library instrumentation from `@opentelemetry/auto-instrumentations-node`
- OpenAI instrumentation from `@traceloop/instrumentation-openai`
- Anthropic instrumentation from `@traceloop/instrumentation-anthropic`
- Google Generative AI instrumentation from `@traceloop/instrumentation-google-generativeai`

`@google/genai` v2 isn't currently supported by the Traceloop Google Generative AI instrumentation.

## Usage

The supported public entrypoint is `@inngest/otel/node`, which resolves to the right runtime file for the loader being used.

The recommended preload path is the Node `--import` flag:

```sh
node --import @inngest/otel/node ./app.js
```

Use `--import` whenever possible. It loads instrumentation before your app, including CommonJS entrypoints.

To choose a module format explicitly, use the format-specific preload path:

```sh
node --import @inngest/otel/node.mjs ./app.js
node --require @inngest/otel/node.cjs ./app.cjs
```

If `--import` isn't an option, use a small bootstrap file that loads instrumentation before loading your app:

```ts
import "@inngest/otel/node";
await import("./app.js");
```
