---
"inngest": minor
---

Experimental agents: an agent's config takes the options of a plain function that make sense for a thread: `name`, `description`, `concurrency`, `retries`, `timeouts`, `cancelOn`, `onFailure`, `idempotency`, `rateLimit`, `throttle`, `priority` and `middleware`. The agent keeps one live run per thread whatever you set, so a concurrency limit or key only limits how many threads run at once. `debounce`, `batchEvents`, `singleton` and `checkpointing` are refused with a type error (and an error at definition for plain JavaScript), because each would break what a thread's run is: a debounce would drop the messages before the last, and the agent reads one event at a time from its inbox.

The body now also receives the function context beside the agent's own fields: `step`, `group`, `defer`, `runId`, `logger`, `attempt` and the rest, so there is no need for `getAsyncCtx()`. `event` stays the agent's (its `data` is the thread message, and `data.event` is the trigger event), and there is no `events`.
