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

## Streaming Option Simplified

The `streaming` option in `serve()` has been simplified from `"allow" | "force" | false` to `true | false`.

- `"force"` → `true` (enable streaming; throws error if handler doesn't support it)
- `"allow"` → removed (use `true` instead)
- `false` → `false` (unchanged)

```typescript
// Old (v3)
serve({ client, functions, streaming: "force" });

// New (v4)
serve({ client, functions, streaming: true });
```

## Optimized Parallelism Now Default

`optimizeParallelism` is now `true` by default, reducing traffic and latency for parallel steps. This changes `Promise.all()`, `Promise.allSettled()`, etc. to wait for all promises to settle before resolving.

If you were using `Promise.race()` and relying on early resolution, use the new `parallel()` helper:

```typescript
import { parallel } from "inngest/experimental";

// Old behavior (no longer works as expected with optimized parallelism)
const winner = await Promise.race([
  step.run("a", () => "a"),
  step.run("b", () => "b"),
]);

// New approach
const winner = await parallel({ mode: "race" }, () =>
  Promise.race([
    step.run("a", () => "a"),
    step.run("b", () => "b"),
  ])
);
```

To revert to v3 behavior, set `optimizeParallelism: false` on your client or function.

## Edge Environment Improvements

In v4, fetch and configuration are now resolved lazily at first use rather than eagerly at client construction. This means you no longer need to manually bind `globalThis.fetch` before creating an Inngest client in edge environments (Cloudflare Workers, Vercel Edge, Deno, etc.).

## Remove String Function IDs in `step.invoke()`

Passing a raw string to `step.invoke()` is no longer supported. Use `referenceFunction()` or pass an imported function instance instead.

```typescript
// Old (v3) - No longer works
await step.invoke("my-step", {
  function: "my-app-other-fn",
  data: { foo: "bar" },
});

// New (v4) - Use referenceFunction for cross-app invocation
import { referenceFunction } from "inngest";

await step.invoke("my-step", {
  function: referenceFunction({ appId: "my-app", functionId: "other-fn" }),
  data: { foo: "bar" },
});

// Or pass an imported function instance directly
import { otherFn } from "./other-fn";

await step.invoke("my-step", {
  function: otherFn,
  data: { foo: "bar" },
});
```

The `referenceFunction()` helper provides type safety and avoids the footgun of manually constructing the `appId-functionId` string.
