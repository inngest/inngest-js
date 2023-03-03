# inngest

## 1.4.0-concurrency.0

### Minor Changes

- fd8df7a: Add ability to control the concurrency of a specific function via the `concurrency` option when creating an Inngest function

## 1.3.5

### Patch Changes

- a4f8ae8: Fixes a typing bug where both `event` and `cron` could be specified as a trigger at the same time.

  Multiple event triggers will be coming in a later update, but not in this format.

- d6a8329: Ensure signatures are not validated during development
- 950a2bc: Ensure `inngest.send()` and `step.sendEvent()` can be given an empty array without error
