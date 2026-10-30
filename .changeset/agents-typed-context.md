---
"inngest": minor
---

Experimental agents: the function context an agent's body receives is typed from the client's middleware like the handler of a plain function, so `step.sandbox` and `group.sandbox` from `sandboxMiddleware()` (and the extensions of your own middleware) need no cast. `createAgents(client)` keeps the type of the client for this; `AgentBodyContext` and `AgentBody` take it as a last type parameter that defaults to any client.
