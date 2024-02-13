# inngest

## 3.14.0

### Minor Changes

- [#484](https://github.com/inngest/inngest-js/pull/484) [`c2b6ec5`](https://github.com/inngest/inngest-js/commit/c2b6ec5336081dc11f94dece0d3b7b54c2c3d419) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add `timeout` to `step.invoke()` options

### Patch Changes

- [#480](https://github.com/inngest/inngest-js/pull/480) [`e1940e4`](https://github.com/inngest/inngest-js/commit/e1940e434192d33b9444106353775063d258a660) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix `GetEvents<>` helper returning internal events by default

- [#479](https://github.com/inngest/inngest-js/pull/479) [`1b2eaed`](https://github.com/inngest/inngest-js/commit/1b2eaed03300a841f6b7c02eaf7baa225d59a049) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix requiring enum value when using an internal event as a trigger

- [#485](https://github.com/inngest/inngest-js/pull/485) [`16973c0`](https://github.com/inngest/inngest-js/commit/16973c05b7505b1368a370c402cde8c0b3b51a3f) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix API failures being masked at runtime when fetching large step data or event batches fails

## 3.13.0

### Minor Changes

- [#475](https://github.com/inngest/inngest-js/pull/475) [`16f02e9`](https://github.com/inngest/inngest-js/commit/16f02e9af43065bb37490c350f2c4040293e0dff) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add `"inngest/bun"` serve handler for use with `Bun.serve()`

### Patch Changes

- [#476](https://github.com/inngest/inngest-js/pull/476) [`4d52f01`](https://github.com/inngest/inngest-js/commit/4d52f01897412db6113eda9d1ebe6bd929b57a79) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Make `data.error` parsing for `inngest/function.failed` more resilient

- [#478](https://github.com/inngest/inngest-js/pull/478) [`9887ac4`](https://github.com/inngest/inngest-js/commit/9887ac474c993f4db9a570bea7986406d05de685) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Remove sending `hash` when syncing

- [#474](https://github.com/inngest/inngest-js/pull/474) [`b3a7b39`](https://github.com/inngest/inngest-js/commit/b3a7b395066f86a7c6227d94b9b007b350f33a7c) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Improve UI when showing an unhandled `StepError`

## 3.12.0

### Minor Changes

- [#411](https://github.com/inngest/inngest-js/pull/411) [`3b35c1c`](https://github.com/inngest/inngest-js/commit/3b35c1c9cfa9d96d88346e874089dc9d3aa9a5de) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add handling of per-step errors and returning step names during error cases to better display issues in the UI

### Patch Changes

- [#469](https://github.com/inngest/inngest-js/pull/469) [`2f01a27`](https://github.com/inngest/inngest-js/commit/2f01a27ab9af871af25349d9be899ae314949485) Thanks [@dependabot](https://github.com/apps/dependabot)! - Bump vite from 4.5.1 to 4.5.2 for a security fix

## 3.11.0

### Minor Changes

- [#467](https://github.com/inngest/inngest-js/pull/467) [`ca93ef8`](https://github.com/inngest/inngest-js/commit/ca93ef87384146c5b852fd74c57b23fecd75685c) Thanks [@tonyhb](https://github.com/tonyhb)! - Add timeouts to debounce configuration

### Patch Changes

- [#463](https://github.com/inngest/inngest-js/pull/463) [`61562bd`](https://github.com/inngest/inngest-js/commit/61562bdaadb2f5a07b8c9e354a3c910e5bf586fe) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix `data` not being required during invocation with a schema+reference

- [#462](https://github.com/inngest/inngest-js/pull/462) [`c449efe`](https://github.com/inngest/inngest-js/commit/c449efef4709ab3aa8c76f4a078e1a793599f717) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix not allowing a single-element `concurrency` option in function definitions

- [#466](https://github.com/inngest/inngest-js/pull/466) [`ecde5b6`](https://github.com/inngest/inngest-js/commit/ecde5b64d17cdc01d3416ca3a6b45b4d21dac234) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix some out-of-date comments and examples

## 3.10.0

### Minor Changes

- [#449](https://github.com/inngest/inngest-js/pull/449) [`a452cf1`](https://github.com/inngest/inngest-js/commit/a452cf1b80e9e2346c21cffdd046d558b0cf4d8b) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add `referenceFunction()`, allowing easier, typed invocation of functions across apps and languages

- [#459](https://github.com/inngest/inngest-js/pull/459) [`eec41d2`](https://github.com/inngest/inngest-js/commit/eec41d23de01f4c977cbcc8bfd986660e0ccbb96) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add new `Inngest.Any` and `InngestFunction.Any` type helpers

### Patch Changes

- [#460](https://github.com/inngest/inngest-js/pull/460) [`a225206`](https://github.com/inngest/inngest-js/commit/a225206e3040463c3f4fd558ec71f3ae21e2f56d) Thanks [@MonsterDeveloper](https://github.com/MonsterDeveloper)! - Add exports for `FinishedEventPayload` and `Context` types to fix a TypeScript error when using Inngest in projects with `composite` setting in `tsconfig`.

## 3.9.0

### Minor Changes

- [#453](https://github.com/inngest/inngest-js/pull/453) [`be6eb2a`](https://github.com/inngest/inngest-js/commit/be6eb2a6abb83578f96fbb17591c7549fbc343e9) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Pass `reqArgs` to `onFunctionRun` middleware hook to be able to use request values within an Inngest function

## 3.8.0

### Minor Changes

- [#441](https://github.com/inngest/inngest-js/pull/441) [`cb0496a`](https://github.com/inngest/inngest-js/commit/cb0496a830662a2f90002feb705f5976a15ab4d3) Thanks [@djfarrelly](https://github.com/djfarrelly)! - Add new `"inngest/astro"` serve handler

## 3.7.4

### Patch Changes

- [#434](https://github.com/inngest/inngest-js/pull/434) [`cb953ee`](https://github.com/inngest/inngest-js/commit/cb953eed62230f6dbf6a689ca24fc9440fc09855) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix bad wildcard export `inngest/components/*` for ESM/CJS compatibility

- [#440](https://github.com/inngest/inngest-js/pull/440) [`0fc642d`](https://github.com/inngest/inngest-js/commit/0fc642de152b7abc19633537ae742cea8a41d958) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix an issue where Sentry's wrapping of `inngest/express` caused Sentry to throw a runtime error during instantiation

## 3.7.3

### Patch Changes

- [#432](https://github.com/inngest/inngest-js/pull/432) [`ce354f3`](https://github.com/inngest/inngest-js/commit/ce354f33f46c97e37ed3794996058cd64a84b678) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add ability to use `z.discriminatedUnion` and `z.union` in schemas

## 3.7.2

### Patch Changes

- [#426](https://github.com/inngest/inngest-js/pull/426) [`49a58d1`](https://github.com/inngest/inngest-js/commit/49a58d1d5fe407202774dfbbd29bbb40f29504ed) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix internal `inngest/*` events not being present when using `new EventSchemas()`

- [#427](https://github.com/inngest/inngest-js/pull/427) [`5cf349c`](https://github.com/inngest/inngest-js/commit/5cf349ccece147f4c6f69ad5389b483e2b7c5d91) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix `EventPayload.id` missing from typing when attempting to send events with `inngest.send()` or `step.sendEvent()`

## 3.7.1

### Patch Changes

- [#421](https://github.com/inngest/inngest-js/pull/421) [`471d11f`](https://github.com/inngest/inngest-js/commit/471d11fce1cee246c017bc6c089f0f5fb5f85d1c) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix serverless use of `inngest/next` with `next@>=13.0.0 <13.5.0` failing to return a response, as well as `next@>=13.5.0` logging the same error

## 3.7.0

### Minor Changes

- [#368](https://github.com/inngest/inngest-js/pull/368) [`e7e845e`](https://github.com/inngest/inngest-js/commit/e7e845e82d426b7017afeb0021f003f78edfaa5a) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add `step.invoke()`, providing the ability to directly invoke a function as a step

### Patch Changes

- [#415](https://github.com/inngest/inngest-js/pull/415) [`ea8dc6f`](https://github.com/inngest/inngest-js/commit/ea8dc6f539942d713bafd4e85aec367e4e23f21d) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Move to Apache License 2.0

## 3.6.2

### Patch Changes

- [#409](https://github.com/inngest/inngest-js/pull/409) [`b56a33e`](https://github.com/inngest/inngest-js/commit/b56a33e17c67d97f838dd557f1412a8f6f9582bb) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Support Remix env vars on Cloudflare Pages via `context.env`

- [#400](https://github.com/inngest/inngest-js/pull/400) [`428a591`](https://github.com/inngest/inngest-js/commit/428a591fd390538f2202868aa6c6a0810e525191) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix Next.js 13 host being stubborn when relying on `req.url` for hosts such as `host.docker.internal`

- [#408](https://github.com/inngest/inngest-js/pull/408) [`4066217`](https://github.com/inngest/inngest-js/commit/4066217b279b7baddc70819ce53233f0fc90d929) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Forward `X-Inngest-Server-Kind` headers to assist in preventing some issues with registration handshakes

- [#406](https://github.com/inngest/inngest-js/pull/406) [`be5544b`](https://github.com/inngest/inngest-js/commit/be5544bf58286dbb7dbf01eb11605f10d612eb4a) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix correctness issues in generated `*.d.ts` files, causing errors for some versions/configurations of TypeScript with `skipLibCheck: false`

## 3.6.1

### Patch Changes

- [#401](https://github.com/inngest/inngest-js/pull/401) [`c77f6d7`](https://github.com/inngest/inngest-js/commit/c77f6d7ec90442221cf9fe2d155b5aa9e540795e) Thanks [@tonyhb](https://github.com/tonyhb)! - Remove "Step already exists; automatically indexing" log

- [#395](https://github.com/inngest/inngest-js/pull/395) [`aebc2c4`](https://github.com/inngest/inngest-js/commit/aebc2c4ba4ca50975437fbbcaed324ac0f34db0b) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix `hasEventKey` in `GET` request always returning `true`

## 3.6.0

### Minor Changes

- [#393](https://github.com/inngest/inngest-js/pull/393) [`f9fca66`](https://github.com/inngest/inngest-js/commit/f9fca668b84a37c831f77949d7f1a714d5cd9040) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Added a new `"inngest/koa"` serve handler. See the [Framework: Koa](https://www.inngest.com/docs/sdk/serve#framework-koa) docs and the [`framework-koa`](/examples/framework-koa) example to get started.

## 3.5.0

### Minor Changes

- [#299](https://github.com/inngest/inngest-js/pull/299) [`ac61617`](https://github.com/inngest/inngest-js/commit/ac61617e77f9f3373cc1c9e32adbe1eace0e8504) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Added a new `"inngest/sveltekit"` serve handler. See the [Framework: Sveltekit](https://www.inngest.com/docs/sdk/serve#framework-sveltekit) docs and the [`framework-sveltekit`](/examples/framework-sveltekit) example to get started.

## 3.4.4

### Patch Changes

- [#388](https://github.com/inngest/inngest-js/pull/388) [`b4432d8`](https://github.com/inngest/inngest-js/commit/b4432d8d98a2e1970dec5a4737cf718fbf184ee1) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Removed "No signing key provided" warning during local development

## 3.4.3

### Patch Changes

- [#385](https://github.com/inngest/inngest-js/pull/385) [`cdf02a3`](https://github.com/inngest/inngest-js/commit/cdf02a310bcf9ef0bb64103f050323c6590bda2b) Thanks [@MonsterDeveloper](https://github.com/MonsterDeveloper)! - Add exports for `InngestFunction`, `FunctionTrigger`, and `Handler` types to fix a TypeScript error when using Inngest in projects with `composite` setting in `tsconfig`.

## 3.4.2

### Patch Changes

- [#378](https://github.com/inngest/inngest-js/pull/378) [`b83f925`](https://github.com/inngest/inngest-js/commit/b83f925099f6c2ecd43fd80a7e4ed9af1ec314a6) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add `INNGEST_API_BASE_URL` and `INNGEST_EVENT_API_BASE_URL`, used for internal testing

- [#382](https://github.com/inngest/inngest-js/pull/382) [`0002afa`](https://github.com/inngest/inngest-js/commit/0002afa7c23ca9c1507fbb40cbc1c806de84fc6f) Thanks [@tonyhb](https://github.com/tonyhb)! - Remove verbose event keys warning

## 3.4.1

### Patch Changes

- [#371](https://github.com/inngest/inngest-js/pull/371) [`d45bfbd`](https://github.com/inngest/inngest-js/commit/d45bfbd42b16170a44c65a09ac650a9d16211de7) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Remove `JsonifyObject<>` wrapper from step output - it's now clearer to see the actual type of a step's result

- [#375](https://github.com/inngest/inngest-js/pull/375) [`e19f9b4`](https://github.com/inngest/inngest-js/commit/e19f9b463add0fbafc6368af7d4b82621d4a03c0) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix failing to parse `BigInt` during step/function result serialization; it is now correctly typed and returned as `never`

- [#374](https://github.com/inngest/inngest-js/pull/374) [`dcafc2b`](https://github.com/inngest/inngest-js/commit/dcafc2b202b2bd2c3a7dfe5d917d635c48f24260) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fixed an issue where an error log wasn't shown if execution result parsing failed, such as in the case of serialization failures

## 3.4.0

### Minor Changes

- [#370](https://github.com/inngest/inngest-js/pull/370) [`48b201a`](https://github.com/inngest/inngest-js/commit/48b201a90f343a1927f38118b732615f77f9ca7f) Thanks [@tonyhb](https://github.com/tonyhb)! - Update concurrency with new scopes and multiple keys

### Patch Changes

- [#369](https://github.com/inngest/inngest-js/pull/369) [`e1046cd`](https://github.com/inngest/inngest-js/commit/e1046cd62430b5599512eb697ebf5ac3fbfd6bb6) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Change `No request version` log from warn to debug

## 3.3.0

### Minor Changes

- [#329](https://github.com/inngest/inngest-js/pull/329) [`2837296`](https://github.com/inngest/inngest-js/commit/2837296fbb938816db7f4b18193ee834fdb13785) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Added `GetStepTools<typeof inngest>` and `GetFunctionInput<typeof inngest>` helper types to aid in building function factories. See [TypeScript Helpers - Inngest Documentation](https://www.inngest.com/docs/typescript#helpers) for more information.

## 3.2.1

### Patch Changes

- [#360](https://github.com/inngest/inngest-js/pull/360) [`260dd75`](https://github.com/inngest/inngest-js/commit/260dd75461bf27188c21614f33d9b1c798fa96bf) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Inngest errors now appear more succintly in UIs, free of ANSI codes and verbose information

## 3.2.0

### Minor Changes

- [#362](https://github.com/inngest/inngest-js/pull/362) [`6bc91d0`](https://github.com/inngest/inngest-js/commit/6bc91d0c60c02ef59dbe18a3f88e31db7854af3c) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add ability to manage function run priorities using a new `priority.run` config option - see the [Priority documentation](https://innge.st/priority) for more information.

### Patch Changes

- [#357](https://github.com/inngest/inngest-js/pull/357) [`9140b66`](https://github.com/inngest/inngest-js/commit/9140b66fb841ea527ca388182b175cb3d86e3493) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Stop "_Failed to send event_" errors occuring in local development when missing an event key

- [#359](https://github.com/inngest/inngest-js/pull/359) [`7f70546`](https://github.com/inngest/inngest-js/commit/7f705464cf18ce44efe0042d05dac9d632b4a010) Thanks [@goodoldneon](https://github.com/goodoldneon)! - Internally, steps now return a `displayName` to be used within Inngest's UIs

## 3.1.1

### Patch Changes

- [#354](https://github.com/inngest/inngest-js/pull/354) [`e2f68d6`](https://github.com/inngest/inngest-js/commit/e2f68d6dba7cc3e6f821d76abdb660793eb6a42f) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix path matching types getting lost in certain recursive event types

- [#350](https://github.com/inngest/inngest-js/pull/350) [`933b998`](https://github.com/inngest/inngest-js/commit/933b99816a1b47a6e4d6ef66db9d557a85407c2e) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Separate Zod typing from library, enabling minor-agnostic versioning support

## 3.1.0

### Minor Changes

- [#338](https://github.com/inngest/inngest-js/pull/338) [`ef35fea`](https://github.com/inngest/inngest-js/commit/ef35feacd35d626b89aea4d35ddfd8c33318d6fc) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add `debounce` configuration option. See [Debounce documentation](https://innge.st/debounce) for more information.

### Patch Changes

- [#337](https://github.com/inngest/inngest-js/pull/337) [`672c428`](https://github.com/inngest/inngest-js/commit/672c428f7ad89b06947b5dc8e81eab1d20ba2039) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Ensure `fromRecord<>()` doesn't accept clashing names

## 3.0.2

### Patch Changes

- [#348](https://github.com/inngest/inngest-js/pull/348) [`ebb245f`](https://github.com/inngest/inngest-js/commit/ebb245f9a6ae40a07173e2645f7614b54cd69c53) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix `"inngest/next"` types not inferring from `defineProperties`

- [#346](https://github.com/inngest/inngest-js/pull/346) [`c14bbb3`](https://github.com/inngest/inngest-js/commit/c14bbb3b0c078ec372b93dfcd39bfd5382d46e93) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix `waitForEvent` potentially dropping some fields when being parsed

## 3.0.1

### Patch Changes

- [#339](https://github.com/inngest/inngest-js/pull/339) [`bf8b004`](https://github.com/inngest/inngest-js/commit/bf8b0042787892a459e6fea24d31331cb58fd5f6) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Bump `next` to `13`; keep up-to-date with their only supported major to support typing

- [#343](https://github.com/inngest/inngest-js/pull/343) [`77c7f66`](https://github.com/inngest/inngest-js/commit/77c7f66c0617a0ad4acf6d07f22f13cafa337c87) Thanks [@tonyhb](https://github.com/tonyhb)! - Allow steps to execute with null data

## 3.0.0

### Major Changes

- [#294](https://github.com/inngest/inngest-js/pull/294) [`f2f4856`](https://github.com/inngest/inngest-js/commit/f2f4856ab97d4191587ea1f41e9fe18b5ef45c95) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Clients and functions now require IDs

  When instantiating a client using `new Inngest()` or creating a function via `inngest.createFunction()`, it's now required to pass an `id` instead of a `name`.

  Previously only `name` was required, but this implied that the value was safe to change. Internally, we used this name to _produce_ an ID which was used during deployments and executions.

  See the [v3 migration guide](https://www.inngest.com/docs/sdk/migration).

- [#294](https://github.com/inngest/inngest-js/pull/294) [`f2f4856`](https://github.com/inngest/inngest-js/commit/f2f4856ab97d4191587ea1f41e9fe18b5ef45c95) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Refactored available environment variables and configuration

  The arrangement of environment variables available has shifted a lot over the course of v2, so in v3 we've streamlined what's available and how they're used.

  See the [v3 migration guide](https://www.inngest.com/docs/sdk/migration).

- [#294](https://github.com/inngest/inngest-js/pull/294) [`f2f4856`](https://github.com/inngest/inngest-js/commit/f2f4856ab97d4191587ea1f41e9fe18b5ef45c95) Thanks [@jpwilliams](https://github.com/jpwilliams)! - In v2, providing a `fns` option when creating a function -- an object of functions -- would wrap those passed functions in `step.run()`, meaning you can run code inside your function without the `step.run()` boilerplate.

  This wasn't a very well advertised feature and had some drawbacks, so we're instead replacing it with some optional middleware.

  See the [v3 migration guide](https://www.inngest.com/docs/sdk/migration).

- [#294](https://github.com/inngest/inngest-js/pull/294) [`f2f4856`](https://github.com/inngest/inngest-js/commit/f2f4856ab97d4191587ea1f41e9fe18b5ef45c95) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Serving functions could become a bit unwieldy with the format we had, so we've slightly altered how you serve your functions to ensure proper discoverability of options and aid in readability when revisiting the code.

  See the [v3 migration guide](https://www.inngest.com/docs/sdk/migration).

- [#294](https://github.com/inngest/inngest-js/pull/294) [`f2f4856`](https://github.com/inngest/inngest-js/commit/f2f4856ab97d4191587ea1f41e9fe18b5ef45c95) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Shorthand function creation removed

  `inngest.createFunction()` can no longer take a string as the first or second arguments; an object is now required to aid in the discoverability of options and configuration.

  See the [v3 migration guide](https://www.inngest.com/docs/sdk/migration).

- [#294](https://github.com/inngest/inngest-js/pull/294) [`f2f4856`](https://github.com/inngest/inngest-js/commit/f2f4856ab97d4191587ea1f41e9fe18b5ef45c95) Thanks [@jpwilliams](https://github.com/jpwilliams)! - All steps require IDs

  When using any step.\* tool, an ID is now required to ensure that determinism across changes to a function is easier to reason about for the user and the underlying engine.

  The addition of these IDs allows you to deploy hotfixes and logic changes to long-running functions without fear of errors, failures, or panics. Beforehand, any changes to a function resulted in an irrecoverable error if step definitions changed. With this, changes to a function are smartly applied by default.

  See the [v3 migration guide](https://www.inngest.com/docs/sdk/migration).

### Patch Changes

- [#333](https://github.com/inngest/inngest-js/pull/333) [`67bda66`](https://github.com/inngest/inngest-js/commit/67bda668fa53afeeb3708e3f245843e9612ccd22) Thanks [@goodoldneon](https://github.com/goodoldneon)! - (Internal) Fix missing name on `NonRetriableError`, ensuring it's correctly (de)serialized

## 2.7.2

### Patch Changes

- [#323](https://github.com/inngest/inngest-js/pull/323) [`3b2efa6`](https://github.com/inngest/inngest-js/commit/3b2efa6e3e12eca45f05d5187c7978bf2e9da23f) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Better error handling for `.sendEvent()` errors from Inngest API, ensuring easier debugging when failing to send events - partial of #256

## 2.7.1

### Patch Changes

- [#325](https://github.com/inngest/inngest-js/pull/325) [`b8858c9`](https://github.com/inngest/inngest-js/commit/b8858c9be1cab32d4e781cf3588047181bfed6a7) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Hotfix: Ensure `ProxyLogger` (and some other used classes/types) is correctly exported from `"inngest"`

## 2.7.0

### Minor Changes

- [#313](https://github.com/inngest/inngest-js/pull/313) [`32c34b3`](https://github.com/inngest/inngest-js/commit/32c34b3a006fe4ea3d482588f6101c969254532e) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add ability to declare and send events without payloads, e.g. `inngest.send({ name: "my.event" });`

- [#310](https://github.com/inngest/inngest-js/pull/310) [`696c411`](https://github.com/inngest/inngest-js/commit/696c411c46dc8255cdfa5480073a417a93b58e63) Thanks [@michealroberts](https://github.com/michealroberts)! - Added h3 framework server handler

### Patch Changes

- [#319](https://github.com/inngest/inngest-js/pull/319) [`71b7d26`](https://github.com/inngest/inngest-js/commit/71b7d268a815cfc3133b0a4cd1cf1a1a599b5d05) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add ESM exports to `inngest` package to avoid extension imports

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
    },
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
    },
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
