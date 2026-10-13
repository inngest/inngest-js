---
"inngest": minor
---

Add experimental `tools` to `step.sandbox` `commands.run`: code running in a sandbox can call functions in your app. Pass `tools: { getCustomer }` and, inside the sandbox, `from inngest_tools import tools` (Python) or `require("inngest_tools")` (Node), then `await tools.getCustomer("cus_1")`. Each call runs in your function as its own durable step, so it is retried and never runs twice, and a tool that still fails raises a `ToolError` the code can catch. Declare a tool with `tool({ input, output, run })` from `inngest/experimental` to validate arguments and results with any Standard Schema and call it with named arguments. A command with `tools` that never calls one is still a single step. `toolOptions` sets the wait window (default 20s), tool timeout (30s), call limit (100) and concurrency (up to 8).
