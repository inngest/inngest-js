---
"inngest": minor
---

Experimental agents: `report()` carries structured data beside its text, and the agent's own `middleware` option types the body. `report({ text, kind, data })` takes `data`, a plain JSON object of at most 32 KB, typed per call: the channel gets it with the text and decides how to show it (the Slack and GitHub adapters show only the text), and it is saved in the post step's result, so a trace or dashboard can render it. Middleware you pass in an agent's config (not only the client's) now types `step`, `group` and the rest of the body's context, so a middleware that adds `step.sandbox` or a dependency needs no cast.
