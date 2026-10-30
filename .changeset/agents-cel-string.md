---
"inngest": minor
---

A thread key expression in `inngest/experimental/agents` can use `string(value)` to join a number into a key, so an event with a numeric id no longer needs a string field. `string()` takes a string, a boolean or a number of the event. The backend reads every JSON number as a double and writes it with Go's shortest `%g`, and the SDK mirrors that: `12345` is `"12345"`, but `1234567` is `"1.234567e+06"`. For ids use `string(int(event.data.id))`, which writes the whole number (`"1234567"`); `int()` is only allowed inside `string()`. A number literal inside `string()` is refused (CEL reads it as an integer, and the SDK cannot tell), so write the string.

```ts
agents.agent(
  {
    id: "issues",
    on: { event: issueOpened, thread: 'event.data.repo + "#" + string(int(event.data.number))' },
  },
  async ({ inbox }) => {
    // ...
  },
);
```
