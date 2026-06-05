# Problem

AI libraries put useful info in OTel attributes (e.g. token count), but we don't have a turnkey way to allow users to query it.

# Solution

Create an OTel processor that extracts allowlisted OTel attributes and then adds them to step metadata (via `inngest.metadata.update()`). Our Insights feature can already query step metadata, so this shouldn't require backend changes.

# Implementation

## High-level

Since the OTel->metadata transform happens SDK-side, we don't need to export these spans. We already have an existing "Extended Traces" feature that exports spans, but that's considered a separate feature. Our changes must not break Extended Traces.

The only attributes we're extracting now are:
- Input tokens
- Output tokens
- Model ID

The processor is installed automatically and follows the same provider setup
approach as Extended Traces: create an OTel provider if one does not exist, or
extend the existing provider when one is already registered.

Metadata is written to step scope with kind `inngest.ai` using kebab-case keys:

```json
{
  "input-tokens": 15,
  "output-tokens": 21,
  "model-id": "gpt-4o-mini"
}
```

For now, each qualifying top-level AI operation span emits its own metadata
update. Numeric values are not aggregated yet.

## Libraries

### `ai`

Example span:

```js
{
  resource: {
    attributes: {
      'service.name': 'customer-app',
      'host.name': 'Aarons-MacBook-Pro-2.local',
      'host.arch': 'arm64',
      'host.id': '2B517F9D-06AD-5DDD-B579-EAC0C593E1F5',
      'process.pid': 14977,
      'process.executable.name': '/Users/aaron/.nvm/versions/node/v26.1.0/bin/node',
      'process.executable.path': '/Users/aaron/.nvm/versions/node/v26.1.0/bin/node',
      'process.command_args': [
        '/Users/aaron/.nvm/versions/node/v26.1.0/bin/node',
        '--require',
        '/Users/aaron/personal/inngest-sandbox/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/preflight.cjs',
        '--import',
        'file:///Users/aaron/personal/inngest-sandbox/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs',
        '-r',
        'dotenv/config',
        '/Users/aaron/personal/inngest-sandbox/ts-express/src/index.ts'
      ],
      'process.runtime.version': '26.1.0',
      'process.runtime.name': 'nodejs',
      'process.runtime.description': 'Node.js',
      'process.command': '/Users/aaron/personal/inngest-sandbox/ts-express/src/index.ts',
      'process.owner': 'aaron',
      'telemetry.sdk.language': 'nodejs',
      'telemetry.sdk.name': 'opentelemetry',
      'telemetry.sdk.version': '2.5.0'
    }
  },
  instrumentationScope: { name: 'ai', version: undefined, schemaUrl: undefined },
  traceId: '0d417c6f4522500ad2c9db7f20f5b844',
  parentSpanContext: {
    traceId: '0d417c6f4522500ad2c9db7f20f5b844',
    spanId: '37b1a03176fa4801',
    traceFlags: 1,
    traceState: TraceState {
      _internalState: Map(3) {
        'inngest@app' => '89f1e603-dd79-564c-af9e-477e931dbb83',
        'inngest@fn' => '807f731e-4230-5fa5-a66a-4003aa52b091',
        'inngest@traceref' => '%7B%22tp%22%3A%2200-b68d70b1546765e8d2f243f72f043ea3-7201dcfbba9ad37f-01%22%2C%22ts%22%3A%22%22%7D'
      }
    }
  },
  traceState: 'inngest@traceref=%7B%22tp%22%3A%2200-b68d70b1546765e8d2f243f72f043ea3-7201dcfbba9ad37f-01%22%2C%22ts%22%3A%22%22%7D,inngest@fn=807f731e-4230-5fa5-a66a-4003aa52b091,inngest@app=89f1e603-dd79-564c-af9e-477e931dbb83',
  name: 'ai.generateText',
  id: 'd58cbf1bf4f67d15',
  kind: 0,
  timestamp: 1780678966243000,
  duration: 2658692.917,
  attributes: {
    'operation.name': 'ai.generateText',
    'ai.operationId': 'ai.generateText',
    'ai.model.provider': 'openai.responses',
    'ai.model.id': 'gpt-4o-mini',
    'ai.settings.maxOutputTokens': 40,
    'ai.settings.maxRetries': 2,
    'ai.request.headers.user-agent': 'ai/6.0.193',
    'ai.prompt': '{"prompt":"Generate exactly one short sentence about distributed tracing"}',
    'ai.response.finishReason': 'stop',
    'ai.response.text': 'Distributed tracing enables developers to visualize the flow of requests across microservices for improved performance monitoring and debugging.',
    'ai.response.providerMetadata': '{"openai":{"responseId":"resp_0dc3766783e3809c006a23013700488197a83a48de091727bc","serviceTier":"default"}}',
    'ai.usage.inputTokens': 15,
    'ai.usage.inputTokenDetails.noCacheTokens': 15,
    'ai.usage.inputTokenDetails.cacheReadTokens': 0,
    'ai.usage.outputTokens': 21,
    'ai.usage.outputTokenDetails.textTokens': 21,
    'ai.usage.outputTokenDetails.reasoningTokens': 0,
    'ai.usage.totalTokens': 36,
    'ai.usage.reasoningTokens': 0,
    'ai.usage.cachedInputTokens': 0
  },
  status: { code: 0 },
  events: [],
  links: []
}
```

## Concerns

- If this becomes default-on or opt-out, users may unexpectedly persist model IDs
  and token usage into Inngest metadata. This should be documented clearly because
  some users have compliance, privacy, or billing-data handling requirements.
- The initial implementation intentionally does not include a disable path. Before
  enabling this broadly, decide whether users need a runtime or client-level escape
  hatch.
- Automatic metadata writes can increase metadata volume for steps that create many
  AI spans. The implementation should avoid unnecessary writes and consider how
  repeated spans in a single step are aggregated.
- Token counts are numeric metrics while model ID is categorical. Merge-only
  metadata updates need a clear convention so multiple spans do not silently
  overwrite data in a surprising way.
