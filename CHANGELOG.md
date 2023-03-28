# inngest

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
