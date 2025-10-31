# OpenTelemetry Usage

## Contents

- [Exports](#exports)
- [Usage](#basic-usage)
  - [Serverless](#serverless)
  - [Extending existing providers](#extending-existing-providers)
  - [Manually extend](#manually-extend)
- [Instrumentation](#instrumentation)
  - [Custom instrumentation](#custom-instrumentation)

## Exports

This directory exports some key pieces for the SDK:

- `processor.ts` provides `InngestSpanProcessor`, used to process and export
  spans to Inngest
- `middleware.ts` provides `extendedTracesMiddleware()`, used to instantiate providers and
  enable it within an app
- `access.ts` provides safe access to span processors when using a client,
  without importing any OTel depedencies, ensuring we can reliably treeshake
  them if not used

## Basic usage

Import and run the `extendedTracesMiddleware()` before any other code.

> [!IMPORTANT]
> This ensures that the [tracer
> provider](https://opentelemetry.io/docs/concepts/signals/traces/#tracer-provider)
> and any
> [instrumentation](https://opentelemetry.io/docs/concepts/instrumentation/) has
> time to patch code in order to collect traces and spans from all parts of your
> application. Loading running `extendedTracesMiddleware()` after any other code risks not
> instrumenting it.

```ts
// Import this first
import { extendedTracesMiddleware } from "inngest";
const otel = extendedTracesMiddleware();

// Then everything else
import { Inngest } from "inngest";

const inngest = new Inngest({
  id: "my-app",
  middleware: [otel],
});
```

### Serverless

If you're using serverless, the entrypoint of your app will likely be the file
for a particular endpoint, for example `/api/inngest`.

If you have your client set up as in the example above, make sure you import
that first so that the provider has a chance to initialize.

```ts
// Import the client first
import { inngest } from "@/inngest";

// Then import everything else
import { serve } from "inngest/next";
import { myFn } from "@/inngest/functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [myFn],
});
```

### Extending existing providers

A JavaScript process can only have a single OpenTelemetry Provider. Some
libraries such as Sentry also create their own provider.

`extendedTracesMiddleware()` will first try to _extend_ an existing provider and will only
create one if none has been found. If an existing provider is extended, we won't
contribute any automatic [instrumentation](#instrumentation).

In the case of Sentry, `extendedTracesMiddleware()` will extend Sentry's provider as long
as it's run after `Sentry.init()`.

> [!NOTE]
> This extension should also work for OpenTelemetry providers that originate
> within the runtime, like [Deno's OpenTelemetry](https://docs.deno.com/runtime/fundamentals/open_telemetry/).

This behaviour can be changed:

```ts
extendedTracesMiddleware({
  behaviour: "auto",
});
```

The options are:

- `"auto"` (default): Attempt to extend a provider if one exists, else create one, fails
  if neither worked
- `"extendProvider"`: Only attempt to extend a provider and fails if none exists
- `"createProvider"`: Only attempt to create a provider and fails if we couldn't
- `"off"`: Do nothing

If you're intending to only use `extendedTracesMiddleware()` to extend an existing
provider, you no longer need to ensure that it is called before any other code.

### Manually extend

If you're already manually creating your own trace provider and import ordering
is an issue, you may want to manually add Inngest's `InngestSpanProcessor` to
your existing setup.

Add an `InngestSpanExporter` to your provider:

```ts
// Create your client the same as you would normally
import { Inngest } from "inngest";
import { extendedTracesMiddleware } from "inngest/experimental";

export const inngest = new Inngest({
  id: "my-app",
  middleware: [
    extendedTracesMiddleware({
      // Make sure the middleware doesn't try to
      behaviour: "off",
    }),
  ],
});
```

```ts
// Then when you create your provider, pass the client to it
import { inngest } from "@/inngest";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { InngestSpanProcessor } from "inngest/experimental";

const provider = new BasicTracerProvider({
  // Add the span processor when creating your provider
  spanProcessors: [new InngestSpanProcessor(inngest)],
});

// Register the provider globally
provider.register();
```

## Instrumentation

`extendedTracesMiddleware()` will automatically instrument common code for you if it's
used to create your provider.

Here's a list of automatic supported instrumentation:

- [amqplib](https://www.npmjs.com/package/amqplib)
- [AWS Lambda](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html)
- [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3)
- [bunyan](https://www.npmjs.com/package/bunyan)
- [cassandra-driver](https://www.npmjs.com/package/cassandra-driver)
- [connect](https://github.com/senchalabs/connect)
- [@cucumber/cucumber](https://www.npmjs.com/package/@cucumber/cucumber)
- [dataloader](https://www.npmjs.com/package/dataloader)
- [dns](http://nodejs.org/dist/latest/docs/api/dns.html)
- [express](https://github.com/expressjs/express)
- [fs](http://nodejs.org/dist/latest/docs/api/fs.html)
- [generic-pool](https://github.com/coopernurse/node-pool)
- [graphql](https://www.npmjs.com/package/graphql)
- [@grpc/grpc-js](https://grpc.io/blog/grpc-js-1.0/)
- [Hapi framework](https://www.npmjs.com/package/@hapi/hapi)
- [http](https://nodejs.org/api/http.html) and
  [https](https://nodejs.org/api/https.html)
- [ioredis](https://github.com/luin/ioredis)
- [kafkajs](https://www.npmjs.com/package/kafkajs)
- [knex](https://github.com/knex/knex)
- [Koa](https://github.com/koajs/koa)
- [lru-memoizer](https://github.com/jfromaniello/lru-memoizer)
- [memcached](https://www.npmjs.com/package/memcached)
- [mongodb](https://github.com/mongodb/node-mongodb-native)
- [mongoose](https://github.com/Automattic/mongoose)
- [mysql](https://www.npmjs.com/package/mysql)
- [mysql2](https://github.com/sidorares/node-mysql2)
- [NestJS framework](https://nestjs.com/)
- [net](http://nodejs.org/dist/latest/docs/api/net.html)
- [pg](https://github.com/brianc/node-postgres)
- [pino](https://www.npmjs.com/package/pino)
- [redis](https://github.com/NodeRedis/node_redis)
- [restify](https://github.com/restify/node-restify)
- [socket.io](https://github.com/socketio/socket.io)
- [undici](https://undici.nodejs.org/) (Node.js global
  [fetch](https://nodejs.org/docs/latest/api/globals.html#fetch) API)
- [winston](https://www.npmjs.com/package/winston)
- [openai](https://www.npmjs.com/package/@opentelemetry/instrumentation-openai)

### Custom instrumentation

You can add additional custom instrumentations to gain more insight into your
stack.

For example, here's an example of adding [Prisma
OpenTelemetry](https://www.prisma.io/docs/orm/prisma-client/observability-and-logging/opentelemetry-tracing):

```ts
import { PrismaInstrumentation } from "@prisma/instrumentation";
import { extendedTracesMiddleware } from "inngest/experimental";

const otel = extendedTracesMiddleware({
  instrumentations: [new PrismaInstrumentation()],
});
```
