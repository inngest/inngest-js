---
"inngest": minor
---

In `inngest/experimental/agents`, a tool with an `output` schema can return `agent.toolError(body)` without a type error, and the error is not checked against the schema. An agent body gets `depth`, how many agents deep an `agent.invoke()` run is (0 for any other trigger), because the body's `trigger` has the SDK's own data removed and `agentInvokeDepth(trigger)` could not read it. `tool({ sandboxCommand })` is removed: it was validated but nothing used it.
