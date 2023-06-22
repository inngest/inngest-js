---
"inngest": minor
---

Add support for batching events.

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
  }
);
```
