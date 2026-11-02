---
"inngest": minor
---

Add experimental agent primitives. See https://www.inngest.com/docs/labs/agents

An agent is defined with `agents.agent(definition, handler?)`. `triggers` takes what `createFunction` triggers take, `idle` ends a run's `for await` loops over its inbox after that much quiet (default 10 minutes), `listen` names the event types the model may start watching with `inbox_listen` and `inbox_close`, and an agent with no handler runs and ends with no output. The handler's `event` is exactly the event that started the run, `me.key` is the thread's key, and a trigger or inbox source with nothing at its thread path never throws.
