---
"inngest": minor
---

`tool.mcp()` now works with OAuth-only MCP servers, one account per user. Give it `auth: { oauth: { user, redirectUri } }`, where `user` names whose token to use (for example the Slack user who asked). The SDK follows the MCP authorization spec: it discovers the server's metadata, registers a client dynamically (or uses the `clientId` you configure), uses PKCE, and refreshes tokens on its own. Tokens live in `kvOAuthStore()` by default, the agents KV encrypted with the key in `MCP_OAUTH_ENCRYPTION_KEY`, and are read only on the host inside the step that makes the call.

A user who has not connected yet gets a `McpNeedsAuthorization` result with a link (read it with `isMcpNeedsAuthorization()`, or post it from `onNeedsAuthorization`). Your callback route calls `completeMcpAuthorization({ store, code, state, send })`, which stores the token and sends `agent/mcp.authorized`; a run that is waiting can continue with `waitForMcpAuthorization({ user, timeout })`. A revoked grant goes back to needing authorization. `fakeMcpServer({ oauth: {} })` in `inngest/experimental/agents/testing` serves the whole OAuth flow for tests.
