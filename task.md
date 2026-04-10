# Goal

I want to implement a new "defer" feature. Here's a code example of the user-facing API:

```ts
inngest.createFunction(
  {
    id: "fn-1",
    onDefer: async ({ event, step }) => {
      // Is "hello"
      event.data.msg;

      await step.run("a", () => {
        console.log("a");
      });
    },
    triggers: { event: "event-1" },
  },
  async ({ defer, event, step }) => {
    const msg = await step.run("create-msg", () => {
      return "hello";
    });

    await step.run("defer-1", async () => {
      await defer({
        id: "defer-1",
        data: {
          msg,
        },
      });
    });
  }
);
```

# Implementation

In some ways this is similar to the `onFailure` option. Under the hood, a full Inngest function is created for the `onFailure` option. It's just triggered by the `inngest/function.failed` event (and a trigger expression), which is sent if the function fails.

A difference for `onDefer` would be that users explicitly trigger it via the `defer` function. To keep things simple to start, have `defer` just send a `deferred.start` event via the normal Event API. Then that event triggers the `onDefer` function.