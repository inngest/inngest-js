---
"inngest": patch
---

`tool.mcp()` now sends requests with `redirect: "manual"` and refuses any redirect it gets back, so MCP and OAuth requests work on Cloudflare Workers. A failed OAuth request now reports the error type and a recognized network code, such as `TypeError (ECONNREFUSED)`, without ever including the error message.
