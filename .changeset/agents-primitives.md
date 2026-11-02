---
"inngest": minor
---

Add experimental agent primitives. See https://www.inngest.com/docs/labs/agents

An agent is defined with `agents.agent(definition, handler?)`. `triggers` takes what `createFunction` triggers take, `idle` ends a run's `for await` loops over its inbox after that much quiet (default 10 minutes), `listen` names the event types the model may start watching with `inbox_listen` and `inbox_close`, and an agent with no handler runs and ends with no output. The handler's `event` is exactly the event that started the run, `me.key` is the thread's key, and a trigger or inbox source with nothing at its thread path never throws.

An agent publishes a card from its optional `card` field (`description`, `share`, `owner`, `effects`, `speed`); cards announce from a cron every 6 hours, and `list_agents({ query, refresh })` and `describe_agent({ address })` find the agents of the same app at once and those of other apps from their announced cards. `discovery: false` turns the discovery tools off, and `discovery: { prepare }` fills part of a call's input from the host.
