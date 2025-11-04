# @inngest/test

## 0.1.9

### Patch Changes

- [#1140](https://github.com/inngest/inngest-js/pull/1140) [`d572e2e9`](https://github.com/inngest/inngest-js/commit/d572e2e9bf8194ce65eea69cdd837def43b79d17) Thanks [@jb-chief](https://github.com/jb-chief)! - @inngest/test: call mock step handlers only once and at the right time

- Updated dependencies [[`9d5d7131`](https://github.com/inngest/inngest-js/commit/9d5d7131c530c000e4b476edf3c44baf62a2bacb), [`68e67d80`](https://github.com/inngest/inngest-js/commit/68e67d8009b210c1aa75c02f50395a3fca952d2f)]:
  - inngest@3.44.5

## 0.1.8

### Patch Changes

- [#1082](https://github.com/inngest/inngest-js/pull/1082) [`8e5ee6a`](https://github.com/inngest/inngest-js/commit/8e5ee6a7f543a30f4271c3eea98efc24e7ed7d23) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Bump `inngest` dependency to `^3.42.0`

  This version changed a lot of `Inngest*.Like` types to future-proof them against updates.
  Before this, all updates caused typing issues when we upgraded, but following this patch we shouldn't see that issue again.

## 0.1.7

### Patch Changes

- [#1022](https://github.com/inngest/inngest-js/pull/1022) [`a15bb56`](https://github.com/inngest/inngest-js/commit/a15bb56debaca557b969ad17a6770250e1c63dd0) Thanks [@MonsterDeveloper](https://github.com/MonsterDeveloper)! - Allow passing `reqArgs`, which can be used to test middleware that takes `reqArgs` and different `serve()` handlers in to account

- Updated dependencies [[`126a984`](https://github.com/inngest/inngest-js/commit/126a984524968854763eb4ed428dc6ca6127236c), [`bff90cc`](https://github.com/inngest/inngest-js/commit/bff90cc580cb68b3d9959adadfe6cd73cf1da252)]:
  - inngest@3.40.0

## 0.1.6

### Patch Changes

- [#898](https://github.com/inngest/inngest-js/pull/898) [`e3c8dfe`](https://github.com/inngest/inngest-js/commit/e3c8dfee031fc7fd1b24e3713805194ee40bf5b4) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Loosen `InngestTestEngine`'s `function` typing, allowing for `InngestFunction`s from many different `inngest` versions to be passed

## 0.1.5

### Patch Changes

- [#786](https://github.com/inngest/inngest-js/pull/786) [`1f3bd4b`](https://github.com/inngest/inngest-js/commit/1f3bd4bac38ebdfa6181609f63dc95a162299201) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix `@inngest/test` not shipping `dist/` files

## 0.1.4

### Patch Changes

- [#776](https://github.com/inngest/inngest-js/pull/776) [`0dbcc87`](https://github.com/inngest/inngest-js/commit/0dbcc874206d8d87c2c1da1773e5390968dfa527) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Altered exports to now be namespaced by `./dist/`; if you have directly imported files from `@inngest/test`, you may need to change the imports

- Updated dependencies [[`0dbcc87`](https://github.com/inngest/inngest-js/commit/0dbcc874206d8d87c2c1da1773e5390968dfa527), [`0dbcc87`](https://github.com/inngest/inngest-js/commit/0dbcc874206d8d87c2c1da1773e5390968dfa527)]:
  - inngest@3.28.0

## 0.1.3

### Patch Changes

- [#777](https://github.com/inngest/inngest-js/pull/777) [`325ef79`](https://github.com/inngest/inngest-js/commit/325ef7925a040090ae7990ae16731bd84a9b3431) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix `@inngest/test` automatic spying not accounting for `step.**`

## 0.1.2

### Patch Changes

- [#749](https://github.com/inngest/inngest-js/pull/749) [`d61a8a2`](https://github.com/inngest/inngest-js/commit/d61a8a2beb8eb9f99d916215365b00a20498f1b8) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix `error` sometimes being `undefined` when a step rejects mid-run

## 0.1.1

### Patch Changes

- [#741](https://github.com/inngest/inngest-js/pull/741) [`6782497`](https://github.com/inngest/inngest-js/commit/67824978ddd3cab7b923555341a2fbfe4ae96280) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix the first step in a run running twice

- [#741](https://github.com/inngest/inngest-js/pull/741) [`6782497`](https://github.com/inngest/inngest-js/commit/67824978ddd3cab7b923555341a2fbfe4ae96280) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Fix immediate function/step failures not returning `error` correctly

## 0.1.0

### Minor Changes

- [#704](https://github.com/inngest/inngest-js/pull/704) [`9438960`](https://github.com/inngest/inngest-js/commit/9438960dbdd3462fc0f2922958e97bbc78bdc27c) Thanks [@jpwilliams](https://github.com/jpwilliams)! - Refactor `@inngest/test` to have a much simpler public API
