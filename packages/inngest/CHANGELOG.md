# inngest

## 2.6.1

### Patch Changes

- [#312](https://github.com/inngest/inngest-js/pull/312) [`ca6d6aa`](https://github.com/inngest/inngest-js/commit/ca6d6aa31512468de0d662e770d622a069adb65e) Thanks [@mmachatschek](https://github.com/mmachatschek)! - chore: update cross-fetch to ^4.0.0 package

## 2.6.0

### Minor Changes

- [#202](https://github.com/inngest/inngest-js/pull/202) [`21053ed`](https://github.com/inngest/inngest-js/commit/21053edeb5a11f2eaa0242d56d36b0aee6ae994f) Thanks [@djfarrelly](https://github.com/djfarrelly)! - Add support for Fastify, either via a custom `.route()` or using a Fastify plugin

  ```ts
  import Fastify from "fastify";
  import inngestFastify, { serve } from "inngest/fastify";
  import { functions, inngest } from "./inngest";

  const fastify = Fastify({
    logger: true,
  });

  // The lead maintainer of Fastify recommends using this as a plugin:
  fastify.register(inngestFastify, {
    client: inngest,
    functions,
    options: {},
  });

  // We do also export `serve()` if you want to use it directly, though.
  fastify.route({
    method: ["GET", "POST", "PUT"],
    handler: serve(inngest, functions),
    url: "/api/inngest",
  });

  fastify.listen({ port: 3000 }, function (err, address) {
    if (err) {
      fastify.log.error(err);
      process.exit(1);
    }
  });
  ```

- [#298](https://github.com/inngest/inngest-js/pull/298) [`4984aa8`](https://github.com/inngest/inngest-js/commit/4984aa85b97fd7b3d38d4fdcb5559c0ecb4307a3) Thanks [@z.object({](https://github.com/z.object({), [@z.object({](https://github.com/z.object({)! - Add the ability to provide Zod schemas using `z.object()` instead of requiring a record format

  ```ts
  // Previously we supported this
  new EventSchemas().fromZod({
    "test.event": {
      data: z.object({ a: z.string() }),
   b: z.number() }),
    },
  });

  // Now we ALSO support this
  new EventSchemas().fromZod([
    z.object({
      name: z.literal("test.event"),
      data: z.object({ a: z.string() }),
   b: z.number() }),
    }),
  ]);
  ```

  This should help if you wish to declare your events piece-by-piece instead of in a single object.

  ```ts
  const firstEvent = z.object({
    name: z.literal("app/user.created"),
    data: z.object({ id: z.string() }),
  });

  const secondEvent = z.object({
    name: z.literal("shop/product.deleted"),
    data: z.object({ id: z.string() }),
  });

  new EventSchemas().fromZod([firstEvent, secondEvent]);
  ```

  You can use the exported `LiteralZodEventSchema` type to provide some autocomplete when writing your events, too.

  ```ts
  const ShopProductOrdered = z.object({
    name: z.literal("shop/product.ordered"),
    data: z.object({ productId: z.string() }),
  }) satisfies LiteralZodEventSchema;
  ```

## 2.5.2

### Patch Changes

- [#305](https://github.com/inngest/inngest-js/pull/305) [`10220af`](https://github.com/inngest/inngest-js/commit/10220af5b666eb1f09cbb47d252edde8c78b5a48) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Always attempt accessing the dev server if the `INNGEST_DEVSERVER_URL` environment variable is specified

  This helps some situations where a user may want to run integration tests against a deployed or otherwise production build, using the Inngest Dev Server to do so.

## 2.5.1

### Patch Changes

- [#302](https://github.com/inngest/inngest-js/pull/302) [`5b2bfac`](https://github.com/inngest/inngest-js/commit/5b2bfac61f3b3f4ecbfdedca3e3c18be1393eb88) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Remove `preinstall` script from `inngest` package causing errors when consuming the package

## 2.5.0

### Minor Changes

- [#289](https://github.com/inngest/inngest-js/pull/289) [`b04d904`](https://github.com/inngest/inngest-js/commit/b04d9045bc5fe289834f756cda2bfd5eb631f18c) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add `attempt` number to SDK function context

  ```ts
  inngest.createFunction(
    { name: "Example Function" },
    { event: "app/user.created" },
    async ({ attempt }) => {
      // ...
    }
  );
  ```

### Patch Changes

- [#293](https://github.com/inngest/inngest-js/pull/293) [`424bfb2`](https://github.com/inngest/inngest-js/commit/424bfb2e5e711837c07d002424c1681839d470f8) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add `key` to `concurrency` types

- [#290](https://github.com/inngest/inngest-js/pull/290) [`b62c88b`](https://github.com/inngest/inngest-js/commit/b62c88ba6045ebaae02ce176a2ab9de4e9b63c78) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Support Vercel's Express (`@vercel/node`) in `"inngest/express"` serve handler

- [#286](https://github.com/inngest/inngest-js/pull/286) [`5587a15`](https://github.com/inngest/inngest-js/commit/5587a15861fe3ca3b8713cc56b9f00141537f6f7) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Updated contribution guidelines

## 2.4.1

### Patch Changes

- f2ffc8b: Fix `cross-fetch` import issue in testing environemtnst. API package also uses custom `fetch` passed via arguments.
- acfa07c: Throw error when using `inngest/express` and not using a body parser
- b535e1e: Ensure users are not allowed to configure batching with cancellation or rate limiting, as these features do not yet function together
- c271eb1: Add `x-inngest-no-retry: true` header when non-retriable for internal executor changes
- 2a93f0b: Fix `onFailure` functions missing types applied by middleware

## 2.4.0

### Minor Changes

- 6cb6719: Allow filtering of events within triggers

### Patch Changes

- 55c889c: Expose raw error message if status is unknown

## 2.3.0

### Minor Changes

- 7792a62: Add support for streaming to `inngest/remix`

## 2.2.1

### Patch Changes

- 1120e29: Genercize mixed async error; the same symptom can be caused by a few different errors

## 2.2.0

### Minor Changes

- d0a8976: Add support for batching events.

  Introduces a new configuration to function configurations.

  ```ts
  batchEvents?: { maxSize: 100, timeout: "5s" }
  ```

  This will take Inngest start execution when one of the following conditions are met.

  1. The batch is full
  2. Time is up

  When the SDK gets invoked, the list of events will be available via a newly exported field `events`.

  ```ts
  createFunction(
    { name: "my func", batchEvents: { maxSize: 100, timeout: "5s" } },
    { event: "my/event" },
    async ({ event, events, step }) => {
      // events is accessible with the list of events
      // event will still be a single event object, which will be the
      // 1st event of the list.

      const result = step.run("do something with events", () => {
        return events.map(() => doSomething());
      });

      return { success: true, result };
    }
  );
  ```

### Patch Changes

- 591f73d: Set `ts` field on sent events if undefined
- 1cbf65e: Alter registration response to include `modified` for deployment deduplication

## 2.1.0

### Minor Changes

- b74477f: Add optional `id` property to all step tooling, allowing users to override state recovery

## 2.0.2

### Patch Changes

- 023d761: Harden error serialization to ensure uncaught exceptions don't slip through during function runs

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
