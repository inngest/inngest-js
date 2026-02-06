# Bun Sync (Durable Endpoints)

This example demonstrates using Inngest's Durable Endpoints with Bun. Durable Endpoints let you use `step.run()` and other step functions directly in your HTTP handlers, turning any endpoint into a durable, resumable workflow.

## Setup

```bash
bun install
```

## Run

```bash
bun run index.ts
```

Then visit http://localhost:3000 to see the durable endpoint in action.

## How it works

1. Configure an `endpointAdapter` on your Inngest client with a custom `asyncRedirectUrl`
2. Wrap your handlers with `inngest.endpoint()`
3. Use `step.run()` and other step functions inside your handler
4. Create a proxy endpoint with `inngest.endpointProxy()` at the redirect URL

When a request takes longer than the sync timeout, the endpoint redirects the user to your proxy endpoint. The proxy fetches the result from Inngest (decrypting it if you use E2E encryption) and returns it to the user.
