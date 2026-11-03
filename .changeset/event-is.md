---
"inngest": minor
---

Narrow an event by its type with `is()`. `myEvent.is(value)` checks any value, including plain JSON such as the result of `step.invoke`, and the `event` your function receives has `event.is(types)`, which takes one event type or an array of them. A multi-trigger function can narrow `event` the same way.

```ts
const issueOpened = eventType("issue.opened", { schema: z.object({ id: z.string() }) });
const issueClosed = eventType("issue.closed");

inngest.createFunction(
  { id: "issues", triggers: [issueOpened, issueClosed] },
  async ({ event }) => {
    if (event.is(issueOpened)) {
      return event.data.id;
    }

    if (event.is([issueOpened, issueClosed])) {
      return event.name;
    }
  },
);
```
