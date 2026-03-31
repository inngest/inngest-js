# Breaking changes

## Requires `inngest` v4

The `inngest` peer dependency is v4. This package no longer works with inngest v3.

## Migrated to class-based middleware API

The middleware now uses the v4 class-based API. You can pass the `SentryMiddleware` class directly to the client's `middleware` array, or use the `sentryMiddleware()` factory to configure options.

```ts
// Direct usage (recommended)
const inngest = new Inngest({
  id: "my-app",
  middleware: [SentryMiddleware],
});

// With options
const inngest = new Inngest({
  id: "my-app",
  middleware: [sentryMiddleware({ disableAutomaticFlush: true })],
});
```

This class replaces the old `SentryMiddleware` type export.

## `inngest.step.op` tag renamed to `inngest.step.type`

The Sentry tag `inngest.step.op` is now `inngest.step.type`. Values now match the step method names without the `step.` prefix (e.g. `run`, `sendEvent`). Update any Sentry dashboards or alerts that filter on the old tag.

# Bug fixes

## Transaction name set on every run

`scope.setTransactionName()` now fires for every run, not only when an error occurs.

