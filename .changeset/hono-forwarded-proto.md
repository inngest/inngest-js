---
"inngest": patch
---

`inngest/hono` now honors the `X-Forwarded-Proto` header when building the request URL, so apps served by `@hono/node-server` behind a TLS-terminating proxy sync with an `https://` URL instead of `http://`
