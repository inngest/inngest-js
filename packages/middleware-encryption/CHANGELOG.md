# @inngest/middleware-encryption

## 1.0.2

### Patch Changes

- [#1082](https://github.com/inngest/inngest-js/pull/1082) [`8e5ee6a`](https://github.com/inngest/inngest-js/commit/8e5ee6a7f543a30f4271c3eea98efc24e7ed7d23) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Bump `inngest` dependency to `^3.42.0`

  This version changed a lot of `Inngest*.Like` types to future-proof them against updates.
  Before this, all updates caused typing issues when we upgraded, but following this patch we shouldn't see that issue again.

## 1.0.1

### Patch Changes

- [#971](https://github.com/inngest/inngest-js/pull/971) [`22ca420`](https://github.com/inngest/inngest-js/commit/22ca420ba3222e537d7f94e250c633ec560d6c69) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Use consistent casing for `libSodium` export

## 1.0.0

### Major Changes

- [#555](https://github.com/inngest/inngest-js/pull/555) [`4469bff`](https://github.com/inngest/inngest-js/commit/4469bffda77a0f3dce614816f1dd79a81ca6f098) Thanks [@goodoldneon](https://github.com/goodoldneon)! - ## Breaking changes

  - Default to using [LibSodium](https://libsodium.gitbook.io/doc)
  - Changed field-level event encryption
  - Custom encryption services now require identifiers

  ## Features

  - Added strategies for AES and LibSodium

  For information on how to migrate, see [MIGRATION.md](https://github.com/inngest/inngest-js/blob/main/packages/middleware-encryption/MIGRATION.md).

## 0.1.7

### Patch Changes

- [#623](https://github.com/inngest/inngest-js/pull/623) [`cc96657`](https://github.com/inngest/inngest-js/commit/cc966578fce01d65a0916ae56c4a47037e2b548f) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Upgraded TypeScript to 5.5.

  No change in behaviour or downstream compatibility is expected, but emitted declaration files will still change, so the patch version will bump for all affected packages.

## 0.1.6

### Patch Changes

- [#604](https://github.com/inngest/inngest-js/pull/604) [`8b41f6b`](https://github.com/inngest/inngest-js/commit/8b41f6b7c7a89d62e851920970de52ba5a3b2734) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Widen range of `inngest` peer dependency

## 0.1.5

### Patch Changes

- [#589](https://github.com/inngest/inngest-js/pull/589) [`8d2a015`](https://github.com/inngest/inngest-js/commit/8d2a0150c722da07f7f2228f3cea677ccd56f29b) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix `inngest` not being correctly defined as a peer dependency of `@inngest/middleware-encryption`

- [#589](https://github.com/inngest/inngest-js/pull/589) [`8d2a015`](https://github.com/inngest/inngest-js/commit/8d2a0150c722da07f7f2228f3cea677ccd56f29b) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Documented all exports

## 0.1.4

### Patch Changes

- [#588](https://github.com/inngest/inngest-js/pull/588) [`b398c6d`](https://github.com/inngest/inngest-js/commit/b398c6d016936b057a3af6c43c717aa9ee723fc7) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Publish `@inngest/middleware-encryption` to JSR

## 0.1.3

### Patch Changes

- [#451](https://github.com/inngest/inngest-js/pull/451) [`5c1c3c6`](https://github.com/inngest/inngest-js/commit/5c1c3c68b07cb18531eb3397e45917fc6e58e590) Thanks [@jessethomson](https://github.com/jessethomson)! - Fix packages sometimes not shipping dist files if released with multiple packages

## 0.1.2

### Patch Changes

- [#430](https://github.com/inngest/inngest-js/pull/430) [`7119cb0`](https://github.com/inngest/inngest-js/commit/7119cb01c3433abed066ec149de540b623e67c87) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add description for `@inngest/middleware-encryption` package

- [#428](https://github.com/inngest/inngest-js/pull/428) [`816ff6c`](https://github.com/inngest/inngest-js/commit/816ff6cee8afd47e3ff012cd286408b09d6e9c49) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Publish declaration files in `@inngest/middleware-encryption`

## 0.1.1

### Patch Changes

- [#419](https://github.com/inngest/inngest-js/pull/419) [`4de1605`](https://github.com/inngest/inngest-js/commit/4de16057e81c9f111fe4a9c84af0e0e62d2567e6) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Add the encryption method used (`AES-256-CBC`) by default to the README

## 0.1.0

### Minor Changes

- [#417](https://github.com/inngest/inngest-js/pull/417) [`327a4a0`](https://github.com/inngest/inngest-js/commit/327a4a0616b20958c045c840c08da9b18d8842b6) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Release the first version of `@inngest/middleware-encryption`
