# v3 -> v4 Migration Guide

This guide covers how to migrate between the v3 and the v4 version of the `inngest` package.

> [!WARNING]
> This migration guide is a work in progress.

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
