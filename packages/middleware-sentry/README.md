# @inngest/middleware-sentry

This package provides a middleware for Inngest to interface with
[Sentry](https://sentry.io).

## Features

- Capture exceptions for reporting
- Add tracing to each function run
- Include useful context for each exception and trace like function ID and event
  names

## Installation

```sh
npm install @inngest/middleware-sentry
```

> [!NOTE]
> Requires `inngest@>=4.0.0` and `@sentry/*@>=8.0.0`

## Usage

To use the middleware, import and initialize it. It assumes that Sentry has
already been initialized elsewhere in your code using `Sentry.init()`.

```ts
import * as Sentry from "@sentry/node";
import { Inngest } from "inngest";
import { sentryMiddleware } from "@inngest/middleware-sentry";

// Initialize Sentry as usual wherever is appropriate
Sentry.init(...);

const inngest = new Inngest({
  id: "my-app",
  middleware: [sentryMiddleware()],
});
```

## Flushing

By default, the middleware will force Sentry to
[flush](https://docs.sentry.io/platforms/javascript/guides/node/configuration/draining/)
as part of the Inngest request, ensuring all events, execptions, and traces are
sent before a response is returned.

This is important for serverless environments where the runtime doesn't wait for
the event loop to be empty and background tasks such as sending exception data
may be lost.

If you're not in a serverless runtime or otherwise wish to have Sentry handle
flushing itself, you can disable this behaviour by setting
`disableAutomaticFlush: true`.

```ts
sentryMiddleware({
  disableAutomaticFlush: true,
});
```
