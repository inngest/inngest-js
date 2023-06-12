# inngest

## 2.0.1

### Patch Changes

- 3ef0b36: Add better visibility into serve handlers issues
- 4226b85: Fix middleware `transformOutput` hook not running if an asynchronous, non-step function's body threw
- cc3929d: Fix a very rare bug in which `step.sleep()` hashing could produce different IDs across different executions

## 2.0.0

### Major Changes

- 4f29f5c: Removed `tools` parameter (breaking). This was marked as `@deprecated` in v1, but is being fully removed in v2. Use `step` instead.
  See the [v2 migration guide](https://www.inngest.com/docs/sdk/migration#clearer-event-sending).
- 4f29f5c: Renamed `throttle` to `rateLimit`.
  See the [v2 migration guide](https://www.inngest.com/docs/sdk/migration#clearer-event-sending).
- 4f29f5c: Added the ability to provide middleware when defining Inngest clients and functions, hooking into a client's lifecycle to add custom functionality like error monitoring, data transformations, and more.
  See [Advanced: Middleware - Inngest Documentation](https://www.inngest.com/docs/reference/middleware/overview).
- 4f29f5c: Removed ability to `serve()` without a client (breaking).
  See the [v2 migration guide](https://www.inngest.com/docs/sdk/migration#clearer-event-sending).
- 4f29f5c: Better event schema definitions (breaking), providing an extensible metho of creating and maintaining event payloads with a variety of native tools and third-party libraries.
  See [Defining Event Payload Types - Inngest Documentation](https://www.inngest.com/docs/reference/client/create#defining-event-payload-types).
- 4f29f5c: Removed some overloads of `inngest.send()` to provide a better TS experience when sending events (breaking).
  See the [v2 migration guide](https://www.inngest.com/docs/sdk/migration#clearer-event-sending).

### Minor Changes

- 4f29f5c: Added a `logger` to Inngest functions in addition to allowing users to provide a custom logger to reliably push logs to external services and handle flushing on serverless environments.
  See [Logging in Inngest - Inngest Documentation](https://www.inngest.com/docs/guides/logging).
- 4f29f5c: Add `GetEvents<>` export which can be used to pull final event types from an Inngest client.
  See [Defining Event Payload Types](https://www.inngest.com/docs/reference/client/create#defining-event-payload-types).
- 4f29f5c: Add ability to provide `concurrency: { limit: number }` in function config, ready for more config options.

### Patch Changes

- b62cd6d: Update landing page vite dependency to v3.2.7

## 1.9.4

### Patch Changes

- 7d025d6: Fix `NonRetriableError` not working when thrown from within a step

## 1.9.3

### Patch Changes

- 64c397e: Handle circular JSON errors while stringifying across the SDK

## 1.9.2

### Patch Changes

- 71b1a17: Fix Vercel platform check to support local dev while using `vercel env pull`

## 1.9.1

### Patch Changes

- 49ddbb5: Add platform deploy checks

## 1.9.0

### Minor Changes

- 48d94a2: Allow user provided logger to be used within functions (experimental)

## 1.8.5

### Patch Changes

- 34f9ee8: INN-1253 Show actionable error when steps are nested

## 1.8.4

### Patch Changes

- aaac9e5: When recommending event key fixes, recommend setting env vars first

## 1.8.3

### Patch Changes

- c09261b: INN-1348 Throw an actionable error when we detect mixed async logic
- 98c15b3: INN-1347 Fix deadlock when an async function finds a step

## 1.8.2

### Patch Changes

- 5462bdd: Ensure Inngest client's env object is used within serve()
- 0b0c0ad: Add consistent type imports for slightly better tree-shaking

## 1.8.1

### Patch Changes

- 5573be3: INN-1270 Create an internal handler to enforce more actionable user-facing errors

## 1.8.0

### Minor Changes

- 65966f5: INN-1087 Add edge streaming support to `"inngest/next"` serve handler

### Patch Changes

- 164fd5c: INN-1266 Fix bad link for fetching Inngest signing key on landing page

## 1.7.1

### Patch Changes

- 34b6d39: INN-1240 Add `queueMicrotask()` fallback for restrictive environments

## 1.7.0

### Minor Changes

- c999896: INN-1029 Add `env` option to `Inngest` client to explicitly push to a particular Inngest env

### Patch Changes

- 131727a: Adjust README to have a slightly clearer intro
- c999896: INN-1186 Send `x-inngest-platform` and `x-inngest-framework` headers during registration
- 0728308: Expose run ID to function executions for user-managed logging and tracing
- 3ac579f: Warn users when some functions appear undefined when serving
- eb1ea34: Allow signing keys with multiple prefixes, as required for branch environment support

## 1.6.1

### Patch Changes

- a840e67: INN-1126 Execute a step early if it's the only pending item during a discovery

  This reduces the number of "Function steps" used for simple step functions.

## 1.6.0

### Minor Changes

- c7d1bee: Add `onFailure` handler to `createFunction` options, allowing you to specify a new function to run when the initial handler fails

## 1.5.4

### Patch Changes

- 071fe89: INN-1054 Ensure serve handlers return `any` instead of `unknown` so that they don't needlessly conflict with user types

## 1.5.3

### Patch Changes

- 906aca5: INN-1009 Show warnings when using the package with TS versions `<4.7.2` and Node versions `<14`

  This includes tests to assert we appropriately support these versions now and in the future.

- ca7d79e: Detect env vars from Node and Deno in serve handlers (INN-1012)

## 1.5.2

### Patch Changes

- 2d6e0b5: Fix infinite type instantiation using a looping type in serve handlers (thanks for the report, @grempe)

## 1.5.1

### Patch Changes

- 0836145: Refactor `InngestCommHandler` to better detect env and reduce duplication (INN-997)

## 1.5.0

### Minor Changes

- ac81320: Add `"inngest/lambda"` serve handler for AWS Lambda environments
- f73a346: Add `"inngest/edge"` serve handler for use in v8 edge runtimes

## 1.4.1

### Patch Changes

- 43162d3: The "_Connected to `inngest dev`_" pill at the top of the SDK's landing page now links to the connected dev server.

  _Thanks, [**@khill-fbmc**](https://github.com/khill-fbmc)!_

  ![image](https://user-images.githubusercontent.com/1736957/225711717-fdc87dda-b8df-4aa4-a76b-233729f4d547.png)

- 56b8e9a: Removes many `any` types from the internal and public APIs.

  Affects the public API, so will therefore be a package bump, but shouldn't affect any expected areas of use.

- a45601e: Update dependency typescript to v5

  Including a bump for this as it does seem to fix some complex inference for future features.

## 1.4.0

### Minor Changes

- ebb8740: Add ability to control the concurrency of a specific function via the `concurrency` option when creating an Inngest function
- e61cf0f: Add `cancelOn` option when creating a function, allowing you cancel execution of a function based on incoming events.

## 1.3.5

### Patch Changes

- a4f8ae8: Fixes a typing bug where both `event` and `cron` could be specified as a trigger at the same time.

  Multiple event triggers will be coming in a later update, but not in this format.

- d6a8329: Ensure signatures are not validated during development
- 950a2bc: Ensure `inngest.send()` and `step.sendEvent()` can be given an empty array without error
