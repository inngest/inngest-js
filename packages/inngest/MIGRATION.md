# v3 -> v4 Migration Guide

This guide covers how to migrate between the v3 and the v4 version of the `inngest` package.

> [!WARNING]
> This migration guide is a work in progress.

## Remove `serveHost` Option, Use `serveOrigin` Instead

Using "host" here was actually a misnomer because the scheme and port can be specified, while a "host" is only the domain or IP. _What is programming_ if not a fun version of pedantry, so we fixed this and removed `serveHost` in favor of `serveOrigin`.

The `INNGEST_SERVE_HOST` environment variable is still supported for backward compatibility but will log a deprecation warning. Please migrate to `INNGEST_SERVE_ORIGIN`.

## Default Mode Changed to Cloud

The default mode is now `cloud` instead of `dev`. This prevents accidental production deployments in development mode and aligns with all other Inngest SDKs.

**What this means:**

- In `cloud` mode, a signing key is required (via `INNGEST_SIGNING_KEY` or the `signingKey` option)
- For local development, explicitly set `isDev: true` on your client or set `INNGEST_DEV=1`

```typescript
// Local development
const inngest = new Inngest({ id: "my-app", isDev: true });

// Production (signing key required via env or option)
const inngest = new Inngest({ id: "my-app" });
```

## Serve Options Moved to Client

Many of the options previously passed to the `serve` function have been moved up to the `client` level. These properties make more sense at this level and, because it only involves potentially reorganizing where you're setting values, should be a very straightforward migration.

The options that you may need to reorganize are:

- **baseUrl**
- **fetch**
- **logLevel**
- **signingKey**
- **signingKeyFallback**

If you are passing any of these values to the `serve` function, or the `createServer` function, you will need to modify your code so that they are instead provided to the client.

```typescript
// Old (v3)
import { Inngest } from "inngest";
import { serve } from "inngest/express";

const inngest = new Inngest({ id: "my-app" });

app.use(
  "/api/inngest",
  serve({
    client: inngest,
    functions,
    signingKey: "my-signing-key",
    signingKeyFallback: "my-fallback-key",
    logLevel: "debug",
    baseUrl: "https://my-inngest-instance.example.com",
  })
);

// New (v4)
import { Inngest } from "inngest";
import { serve } from "inngest/express";

const inngest = new Inngest({
  id: "my-app",
  signingKey: "my-signing-key",
  signingKeyFallback: "my-fallback-key",
  logLevel: "debug",
  baseUrl: "https://my-inngest-instance.example.com",
});

app.use("/api/inngest", serve({ client: inngest, functions }));
```

> [!NOTE]
> If you were relying on environment variables (e.g., `INNGEST_SIGNING_KEY`) rather than passing these options explicitly, no changes are required—the client will automatically read from the environment.

## Edge Environment Improvements

In v4, fetch and configuration are now resolved lazily at first use rather than eagerly at client construction. This means you no longer need to manually bind `globalThis.fetch` before creating an Inngest client in edge environments (Cloudflare Workers, Vercel Edge, Deno, etc.).
