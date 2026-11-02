---
"inngest": minor
---

`tool.mcp()` sign-in is safer. The model never sees the sign-in link: your `onNeedsAuthorization({ url, server, thread, user })` hook gets it, and the model is only told that a link was sent (without the hook it gets an error and the run's log gets a warning). Mount `mcpCallback({ store })`, a `Request` to `Response` handler, on the route of your `redirectUri`; the link is tied to the browser that first opens it, so a forwarded link can't be finished by someone else. `waitForMcpAuthorization`, `isMcpNeedsAuthorization` and `completeMcpAuthorization` are removed.

`tool.mcp()` now requires an `id`, and stored tokens are keyed by it. Tokens stored before this change were keyed by a hash of the server's URL and are not found: users sign in again. `disconnect(server, user)` and `server.disconnect(user)` remove a user's token. `auth.oauth.user` gets `{ runId, event, thread }`.

MCP calls go through a network guard: `https:` only (`http:` for localhost), no private or internal addresses, no credentials in the URL, and any redirect is an error. The guard reads the URL and does not resolve DNS.
