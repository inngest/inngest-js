---
"inngest": patch
---

Fix `inngest/node` failing every request when `X-Forwarded-Proto` holds a comma-separated list, and stop a malformed `Host` or `X-Forwarded-Proto` header from crashing `createServer()` and the endpoint servers
