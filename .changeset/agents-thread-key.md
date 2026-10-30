---
"inngest": minor
---

An agent in `inngest/experimental/agents` can start from an event. List the events in `on` and give each a `thread` expression, a CEL expression over `event` that names the conversation (`event.data.channel + "/" + event.data.thread_ts`). The first event for a thread starts the run and later ones reach the live run as messages, with one run per thread. The expression is evaluated by Inngest as the function's singleton key, so it is a string rather than a JavaScript function. The key is the thread's address, so equal keys from different events are the same thread. `step.subscribe()` also takes `events`, a list of events merged into one inbox.

```ts
const support = agents.agent(
  {
    id: "support",
    on: {
      event: "slack/message",
      thread: 'event.data.channel + "/" + event.data.thread_ts',
    },
  },
  async ({ inbox }) => {
    for await (const message of inbox) {
      // every message of the Slack thread, one run
    }
  },
);
```
