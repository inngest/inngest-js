---
"inngest": minor
---

Add experimental `step.subscribe()` and `Inbox`, behind `inboxMiddleware()` from `inngest/experimental`. `step.subscribe(id, sources)` opens an inbox inside a run: every event that matches one of the sources and arrives afterwards becomes a message the run can read with `inbox.next()`, in the order the messages arrive, whether or not the run is waiting at that moment. On an executor that does not support inboxes (an older Dev Server or Cloud), `step.subscribe` fails at once with an error that says what to upgrade instead of leaving a read waiting.

```ts
import { Inngest } from "inngest";
import { inboxMiddleware } from "inngest/experimental";

const inngest = new Inngest({
  id: "my-app",
  middleware: [inboxMiddleware()],
});

inngest.createFunction(
  { id: "reviews", triggers: [{ event: "pr/opened" }] },
  async ({ event, step }) => {
    await using inbox = step.subscribe("reviews", {
      event: "pr/reviewed",
      if: "async.data.pr == event.data.pr",
    });

    const review = await inbox.next();
  },
);
```
