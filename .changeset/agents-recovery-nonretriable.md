---
"inngest": patch
---

An agent with `recovery` no longer resends the turn of a run that failed with a `NonRetriableError`. The failure is still reported on the agent's channels, but a fresh run would only fail the same way, so nothing is resent.
