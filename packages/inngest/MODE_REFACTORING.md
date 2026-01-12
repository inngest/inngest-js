# Mode Refactoring Plan (v4 SDK)

## Goal

Simplify the `Mode` system to be explicit and predictable, ensuring users don't accidentally deploy in dev mode.

## Key Decisions

### 1. `Mode` is a simple union type
Changed from a `Mode` class to `"cloud" | "dev"` union. Cleaner, more idiomatic.

### 2. `_explicitMode` preserves user intent
If user passes `isDev: true/false` to constructor, this takes precedence over env vars. Stored in `_explicitMode` and passed to `getMode()` on every recalculation.

### 3. `_explicitDevUrl` stays on client
Required for `INNGEST_DEV=<url>` shorthand that sets both mode AND base URLs in one variable.

### 4. Edge environments handled via adapters
Adapters (Cloudflare, Vercel Edge, etc.) call `client.setEnvVars(env)` before handling requests. Explicit, traceable, no hidden magic.

### 5. Handler does NOT sync back to client
Handler and client maintain separate state. Handler computes its own mode at request time using `client._explicitMode` for precedence.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Adapter (cloudflare.ts, edge.ts, etc.)                      │
│ - Calls client.setEnvVars(env) for edge platforms           │
│ - Bridges platform-specific env var patterns                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Client (Inngest)                                            │
│ - _mode: "cloud" | "dev"                                    │
│ - _explicitMode?: Mode (from isDev constructor option)      │
│ - _explicitDevUrl?: URL (from INNGEST_DEV=<url>)            │
│ - _env: Env (current env vars)                              │
│ - _apiBaseUrl, _eventBaseUrl (derived from above)           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Handler (InngestCommHandler)                                │
│ - Own _mode, _explicitDevUrl computed at request time       │
│ - Uses client._explicitMode for precedence over env vars    │
│ - Handles signature validation, registration, introspection │
└─────────────────────────────────────────────────────────────┘
```

## Mode Precedence

```
1. Constructor isDev option (_explicitMode)
2. INNGEST_DEV env var (URL or boolean)
3. Default: "cloud"
```

## Completed Work

- [x] Simplified `Mode` from class to `"cloud" | "dev"` union
- [x] `getMode()` returns `{ mode, explicitDevUrl? }`
- [x] `resolveUrl()` helper for URL resolution
- [x] Fixed `setEnvVars()` to pass `_explicitMode`
- [x] Removed dead `mode` getter/setter from handler
- [x] Updated all mode checks to string comparison

## Remaining Work

### Adapter `setEnvVars()` Calls - NOT IMPLEMENTED

The original plan was to have adapters call `client.setEnvVars(env)` before handling requests. However, this causes issues because:

1. **Handler reads client state**: The `InngestCommHandler` reads several properties from the client that `setEnvVars` modifies:
   - `client.eventKey` - Used for hashing and validation
   - `client.inngestApi` - Base URL is updated by `setEnvVars`
   - `client.eventKeySet()` - Checks if event key is set

2. **State interference**: When `setEnvVars` is called with the platform's env vars, it can overwrite client state that was set during construction, causing:
   - Event key to become the dummy placeholder
   - API base URLs to change unexpectedly
   - Registration requests to fail

3. **Handler already handles env correctly**: The handler computes its own mode via `getMode()` in `initRequest`, using:
   - `client._explicitMode` for precedence (preserved correctly)
   - Merged env from `allProcessEnv()` and platform-specific `actions.env()`

### Current Behavior (Working)

Edge adapters (cloudflare, deno/fresh) pass env to the handler's internal `env: () => env` callback. The handler then:
1. Merges platform env with `allProcessEnv()` in `initRequest`
2. Calls `getMode()` with this merged env
3. Respects `client._explicitMode` for precedence

This works correctly without needing to call `setEnvVars()` on the client.

### When `setEnvVars()` IS Needed

Users should call `client.setEnvVars(env)` manually if they need to:
- Send events from within functions on edge platforms
- Access `client.mode` for logging/debugging

This should be done explicitly by the user when needed, not automatically by adapters.

## Non-Blockers Reviewed

- **Type handling**: Cloudflare `env` has non-string bindings; filter in adapter
- **Concurrent requests**: Edge runtimes are single-threaded; no race conditions
- **Backward compatibility**: Safe; additive change only
- **Existing tests**: Should pass; handler already gets correct env vars
