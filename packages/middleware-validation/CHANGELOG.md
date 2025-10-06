# @inngest/middleware-validation

## 0.0.5

### Patch Changes

- [#1125](https://github.com/inngest/inngest-js/pull/1125) [`49fbfdd9`](https://github.com/inngest/inngest-js/commit/49fbfdd9949f3fba18f6c8e00b0c798132fd9f4b) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Bump version of `inngest` to `^3.44.1` to ensure we have `.fromSchema()` support

- Updated dependencies [[`c2b249aa`](https://github.com/inngest/inngest-js/commit/c2b249aa5947e30984e57b3baa578e33c7f527b2)]:
  - inngest@3.44.2

## 0.0.4

### Patch Changes

- [#1114](https://github.com/inngest/inngest-js/pull/1114) [`c191c93a`](https://github.com/inngest/inngest-js/commit/c191c93a58f86a7354155e38b1e5316f167337f3) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix `.fromSchema()`-defined schemas not being compatible with `@inngest/middleware-validation`

## 0.0.3

### Patch Changes

- [#1082](https://github.com/inngest/inngest-js/pull/1082) [`8e5ee6a`](https://github.com/inngest/inngest-js/commit/8e5ee6a7f543a30f4271c3eea98efc24e7ed7d23) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Bump `inngest` dependency to `^3.42.0`

  This version changed a lot of `Inngest*.Like` types to future-proof them against updates.
  Before this, all updates caused typing issues when we upgraded, but following this patch we shouldn't see that issue again.

## 0.0.2

### Patch Changes

- [#953](https://github.com/inngest/inngest-js/pull/953) [`6ac90b5`](https://github.com/inngest/inngest-js/commit/6ac90b5680c8f4f7dbe9fcdc3c6fda3a5d4e284c) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix possibility of silently failing when multiple versions of Zod are installed

- Updated dependencies [[`a641cc2`](https://github.com/inngest/inngest-js/commit/a641cc219846a2c6ef66ad62fb371725555e7caa)]:
  - inngest@3.35.0

## 0.0.1

### Patch Changes

- [#744](https://github.com/inngest/inngest-js/pull/744) [`0c2bb8e`](https://github.com/inngest/inngest-js/commit/0c2bb8e048f39500e25ed0b521db210bbc4a757d) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Initial release of `@inngest/middleware-validation`

- Updated dependencies [[`255416c`](https://github.com/inngest/inngest-js/commit/255416c4478ac367381da0c166b6762056d94e1d), [`efc6c79`](https://github.com/inngest/inngest-js/commit/efc6c79d5a1baf7a011396b8406aea4982f03778)]:
  - inngest@3.27.0
