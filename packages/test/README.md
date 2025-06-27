# @inngest/test

This package helps you test your Inngest functions with Jest-compatible mocking,
allowing you to mock function state, step tooling, and inputs. Jest
compatibility means we aim for compatibility with all major testing frameworks,
runtimes, and libraries:

- `jest`
- `vitest`
- `bun:test` (Bun)
- `@std/expect` (Deno)
- `chai`/`expect`

## Table of contents

- [Installation](#installation)
- [Running tests](#running-tests)
  - [Running an entire function](#running-tests)
  - [Running an individual step](#running-an-individual-step)
- [Assertions](#assertions)
  - [Function/step output](#assertions)
  - [Function input](#assertions)
  - [Step state](#assertions)
- [Mocking](#mocking)
  - [Events](#event-data)
  - [Steps](#step-data)
  - [Modules and imports](#modules-and-imports)
  - [Custom](#custom)
- [TODO](#known-issues--todo)

## Installation

This package requires `inngest@>=3.22.12`.

```
npm install -D @inngest/test
```

## Running tests

Use whichever supported testing framework; `@inngest/test` is unopinionated
about how your tests are run. We'll demonstrate here using `jest`.

We import `InngestTestEngine` and our target function, `helloWorld`, and create
a new `InngestTestEngine` instance.

```ts
import { InngestTestEngine } from "@inngest/test";
import { helloWorld } from "./helloWorld";

describe("helloWorld function", () => {
  const t = new InngestTestEngine({
    function: helloWorld,
  });
});
```

Within that, we'll add a new test using the primary API,
`t.execute()`:

```ts
test("returns a greeting", async () => {
  const { result } = await t.execute();
  expect(result).toEqual("Hello World!");
});
```

This will run the entire function (steps and all) to completion, then return the
response from the function, where we assert that it was the string `"Hello
World!"`.

An error

### Running an individual step

`t.executeStep()` can be used to run the function until a particular step has
been executed. This is useful to test a single step within a function or to see
that a non-runnable step such as `step.waitForEvent()` has been registered with
the correct options.

```ts
test("runs the price calculations", async () => {
  const { result } = await t.executeStep("calculate-price");
  expect(result).toEqual(123);
});
```

Assertions can also be made on steps in any part of a run, regardless of if
that's the checkpoint we've waited for. See [Assertions -> State](#assertions).

## Assertions

Inngest adds like Jest-compatible mocks by default that can help you assert
function and step input and output. You can assert:

- Function input
- Function output
- Step output
- Step tool usage

All of these values are returned from both `t.execute()` and `t.executeStep()`;
we'll only show one for simplicity here.

The `result` is returned, which is the output of the run or step:

```ts
const { result } = await t.execute();
expect(result).toEqual("Hello World!");
```

`ctx` is the input used for the function run. This can be used to assert outputs
that are based on input data such as `event` or `runId`:

```ts
const { ctx, result } = await t.execute();
expect(result).toEqual(`Run ID was: "${ctx.runId}"`);
```

> [!NOTE]
> The tests also run middleware, so you can test that middleware inputs are also
> being used correctly.

The step tooling at `ctx.step` are Jest-compatible spy functions, so you can use
them to assert that they've been called and used correctly:

```ts
const { ctx } = await t.execute();
expect(ctx.step.run).toHaveBeenCalledWith("my-step", expect.any(Function));
```

`state` is also returned, which is a view into the outputs of all of the steps
in the run. This allows you to test each individual step output for any given
input:

```ts
const { state } = await t.execute();
expect(state["my-step"]).resolves.toEqual("some successful output");
expect(state["dangerous-step"]).rejects.toThrowError("something failed");
```

## Mocking

Some mocking is done automatically by `@inngest/test`, but can be overwritten if
needed.

All mocks (detailed below) can be specified either when creating an `InngestTestEngine` instance
or for each individual execution:

```ts
// Set the events for every execution
const t = new InngestTestEngine({
  function: helloWorld,
  // mocks here
});

// Or for just one, which will overwrite any current event mocks
t.execute({
  // mocks here
});

t.executeStep("my-step", {
  // mocks here
})
```

You can also clone an existing `InngestTestEngine` instance to encourage re-use
of complex mocks:

```ts
// Make a direct clone, which includes any mocks
const otherT = t.clone();

// Provide some more mocks in addition to any existing ones
const anotherT = t.clone({
  // mocks here
});
```

For simplicity, the following examples will show usage of
`t.execute()`, but the mocks can be placed in any of these locations.

### Event data

The incoming event data can be mocked. They are always specified as an array of
events to allow also mocking batches.

```ts
t.execute({
  events: [{ name: "demo/event.sent", data: { message: "Hi!" } }],
});
```

If no event mocks are given at all (or `events: undefined` is explicitly set),
an `inngest/function.invoked` event will be mocked for you.

### Step data

Mocking step data can help you model different paths and situations within your
function. To do so, any step can be mocked by providing the `steps` option.

Here we mock two steps, one that will run successfully and another that will
model a failure and throw an error.

```ts
t.execute({
  steps: [
    {
      id: "successful-step",
      handler() {
        return "We did it!";
      },
    },
    {
      id: "dangerous-step",
      handler() {
        throw new Error("Oh no!");
      },
    },
  ],
});
```

These handlers will run lazily when they are found during a function's
execution. This means you can write complex mocks that respond to other
information:

```ts
let message = "";

t.execute({
  steps: [
    {
      id: "build-greeting",
      handler() {
        message = "Hello, ";
        return message;
      },
    },
    {
      id: "build-name",
      handler() {
        return message + " World!";
      },
    },
  ],
});
```

> [!NOTE]
> We'll later add `ctx` and `state` to the input of `handler`, meaning you'll
> get much easier access to existing state and function input in order to
> provide more accurate mocks.

### Modules and imports

Any mocking of modules or imports outside of Inngest which your functions may
rely on should be done outside of Inngest with the testing framework you're
using. For convenience, here are some links to the major supported frameworks
and their guidance for mocking imports:

- [`jest`](https://jestjs.io/docs/mock-functions#mocking-modules)
- [`vitest`](https://vitest.dev/guide/mocking#modules)
- [`bun:test` (Bun)](https://bun.sh/docs/test/mocks#module-mocks-with-mock-module)
- [`@std/testing` (Deno)](https://jsr.io/@std/testing/doc/mock/~)

### Request arguments (reqArgs)

Request arguments can be passed to the function execution to support middleware
that relies on particular serve handler usage. These can be specified either when
creating an `InngestTestEngine` instance or for individual executions:

```ts
// Set reqArgs for every execution
const t = new InngestTestEngine({
  function: helloWorld,
  reqArgs: [request, response], // Express req/res objects for example
});

// Or for just one execution
t.execute({
  reqArgs: [request, response],
});

t.executeStep("my-step", {
  reqArgs: [request, response],
});
```

This is particularly useful when testing functions that use middleware requiring
specific serve handler context.

### Custom

While the package performs some basic mocks of the input object to a function in
order to spy on `ctx.step.*`, you can provide your own mocks for the function
input to do whatever you want with.

When instantiating a new `InngestTestEngine` or starting an execution, provide a
`transformCtx` function that will add these mocks every time the function is
run:

```ts
const t = new InngestTestEngine({
  function: helloWorld,
  transformCtx: (ctx) => {
    return {
      ...ctx,
      event: someCustomThing,
    };
  },
});
```

If you wish to still add the automatic spies to `ctx.step.*`, you can import and
use the automatic transforms as part of your own:

```ts
import { InngestTestEngine, mockCtx } from "@inngest/test";

const t = new InngestTestEngine({
  function: helloWorld,
  transformCtx: (ctx) => {
    return {
      ...mockCtx(ctx),
      event: someCustomThing,
    };
  },
});
```

## Known issues / TODO

- There are currently no retries modelled; any step or function that fails once
  will fail permanently
- `onFailure` handlers are not run automatically
- Mocked step outputs do not model the JSON (de)serialization process yet, so
  some typing may be off (e.g. `Date`)
- Calling `inngest.send()` within a function is not yet automatically mocked, likely
  resulting in an error
