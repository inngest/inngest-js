---
"inngest": minor
---

`tool.mcp({ url, auth, tools })` makes a remote MCP server's tools available to an agent. Put the handle in `agent.loop({ tools: { hex } })` and the model sees `hex_<tool>`; `await hex.tools()` gives the same tools as a plain record for `sandbox.tools.code({ tools })`, so `run_code` scripts can call them too. Each call is a durable step that reads the bearer token inside the step with `secret("NAME")`, so it never reaches the model, a sandbox, a step output or a trace. The tool list is read once per run, and a request that was sent but got no answer is reported to the model as an unknown outcome instead of being retried, unless the server marks the tool read-only or idempotent. `inngest/experimental/agents/testing` adds `fakeMcpServer()` and `fakeMcpFetch()` for tests.
