# Definition of done

Create an `InngestMiddlewareV2` class. It only has 1 method: `transformStep`. This method is called before a `step` method is run.

So if I used this middleware:
```ts
class MyMiddleware extends InngestMiddlewareV2 {
  async transformStep(handler: () => unknown) {
    console.log("before running")
    const output = await handler();
    console.log("after running");
    return "Transformed"
  }
}
```

And wrote this Inngest function:
```ts
inngest.createFunction({
  id: "fn",
  async ({ step }) => {
    const output = await step.run("step", () => {
        console.log("running step");
        return "Hello, world!";
    });
    console.log("output: ", output);
  },
});
```

Then I'd see this in the console:
```
before running
running step
after running
output: Hello, world!
```

# Context

The `transformStep` method gives users an opportunity to transform the step output before it's returned to the caller.

# Implementation

`packages/inngest/src/components/InngestMiddlewareV2.ts` already exists. You need to create a `packages/inngest/src/components/InngestMiddlewareV2.test.ts` file that tests the behavior defined in this spec.
