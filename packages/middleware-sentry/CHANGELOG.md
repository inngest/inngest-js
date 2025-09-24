# @inngest/middleware-sentry

## 0.1.3

### Patch Changes

- [#1082](https://github.com/inngest/inngest-js/pull/1082) [`8e5ee6a`](https://github.com/inngest/inngest-js/commit/8e5ee6a7f543a30f4271c3eea98efc24e7ed7d23) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Bump `inngest` dependency to `^3.42.0`

  This version changed a lot of `Inngest*.Like` types to future-proof them against updates.
  Before this, all updates caused typing issues when we upgraded, but following this patch we shouldn't see that issue again.

## 0.1.2

### Patch Changes

- [#810](https://github.com/inngest/inngest-js/pull/810) [`47b08dd`](https://github.com/inngest/inngest-js/commit/47b08dd8e5d1a47c28be528e8df9f44244578ac8) Thanks [@djfarrelly](https://github.com/djfarrelly)! - Updated to use Sentry's withIsolationScope

## 0.1.1

### Patch Changes

- [#673](https://github.com/inngest/inngest-js/pull/673) [`42f0e71`](https://github.com/inngest/inngest-js/commit/42f0e71e55186941378159e57c752c177bf79b42) Thanks [@mattddean](https://github.com/mattddean)! - Add event ID as a Sentry tag

- [#672](https://github.com/inngest/inngest-js/pull/672) [`b637d3a`](https://github.com/inngest/inngest-js/commit/b637d3a5cee9bd4792912185077ab9184ba6d364) Thanks [@mattddean](https://github.com/mattddean)! - Set sentry transaction name according to Inngest function

## 0.1.0

### Minor Changes

- [#598](https://github.com/inngest/inngest-js/pull/598) [`cb4fdfd`](https://github.com/inngest/inngest-js/commit/cb4fdfdcd39b5051b87e736d3c18948dec9c2b30) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Initial release!
