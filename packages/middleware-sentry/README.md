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

To use the middleware, pass the `SentryMiddleware` class to your Inngest client.
It assumes that Sentry has already been initialized elsewhere in your code using
`Sentry.init()`.

```ts
import * as Sentry from "@sentry/node";
import { Inngest } from "inngest";
import { SentryMiddleware } from "@inngest/middleware-sentry";

// Initialize Sentry as usual wherever is appropriate
Sentry.init(...);

const inngest = new Inngest({
  id: "my-app",
  middleware: [SentryMiddleware],
});
```

To customize options, use the `sentryMiddleware()` factory:

```ts
import { sentryMiddleware } from "@inngest/middleware-sentry";

const inngest = new Inngest({
  id: "my-app",
  middleware: [sentryMiddleware({ onlyCaptureFinalAttempt: false })],
});
```

## Options

### `captureStepErrors`

**Default: `false`**

When `true`, step-level errors are captured as separate Sentry events in
addition to function-level errors. Each step error event is tagged with
`inngest.error.source: "step"` and `inngest.step.name` so you can distinguish
them from function-level events (`inngest.error.source: "run"`).

When `false`, step errors are still visible as error spans and breadcrumbs in
traces, but only function-level errors produce Sentry events.

### `onlyCaptureFinalAttempt`

**Default: `true`**

When `true`, exceptions are only sent to Sentry on the final attempt of a step
or function run (when retries are exhausted or the error is non-retriable).
Intermediate retry attempts still set span error status and add breadcrumbs, but
won't create Sentry events. Set to `false` to capture every attempt.

### `disableAutomaticFlush`

**Default: `false`**

By default, the middleware will force Sentry to
[flush](https://docs.sentry.io/platforms/javascript/guides/node/configuration/draining/)
as part of the Inngest request, ensuring all events, exceptions, and traces are
sent before a response is returned.

This is important for serverless environments where the runtime doesn't wait for
the event loop to be empty and background tasks such as sending exception data
may be lost.

If you're not in a serverless runtime or otherwise wish to have Sentry handle
flushing itself, set this to `true`.
