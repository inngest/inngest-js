# Realtime Schema Validation Example

Demonstrates the difference between **runtime-validated schemas** (Zod) and **type-only schemas** (`staticSchema`) when publishing and subscribing to realtime channels.

## Key concepts

Inngest realtime topics support two schema approaches:

| | Zod (or any Standard Schema) | `staticSchema<T>()` |
|---|---|---|
| **Compile-time types** | Yes | Yes |
| **Runtime validation** | Yes — rejects invalid data | No — passthrough, zero cost |
| **Publish behavior** | Throws on invalid data | Always succeeds |
| **Subscribe behavior** | Drops invalid messages | Always passes through |
| **Bundle cost** | Includes Zod | Zero |

Both provide identical TypeScript autocomplete and compile-time type checking. The difference is purely at runtime.

## How it works

The example defines a single channel with two topics in [`channels.ts`](./channels.ts):

- **`status`** — uses a Zod schema, so invalid data is rejected at runtime on both publish and subscribe
- **`tokens`** — uses `staticSchema<T>()`, so only TypeScript types are enforced (no runtime validation)

The function in [`index.ts`](./index.ts) publishes both valid and invalid data to each topic, showing:

1. Valid Zod topic publish — succeeds
2. Invalid Zod topic publish — **throws** `Schema validation failed`
3. Valid staticSchema topic publish — succeeds
4. Invalid staticSchema topic publish — **succeeds** (passthrough)

## Subscribe-side validation

Validation also runs on the subscribe side (both `useRealtime` and `inngest.realtime.subscribe()`). It's enabled by default and can be opted out:

```ts
// Validation on (default) — Zod topics reject invalid incoming messages
const stream = await inngest.realtime.subscribe({
  channel: pipeline({ runId }),
  topics: ["status", "tokens"],
});

// Validation off — all messages pass through regardless of schema
const stream = await inngest.realtime.subscribe({
  channel: pipeline({ runId }),
  topics: ["status", "tokens"],
  validate: false,
});
```

When subscribe-side validation is on and a message fails, it is silently dropped (logged to `console.error` but not forwarded to the subscriber).

## Running

```bash
npm install
npm run dev
```

Requires the Inngest dev server. The `dev` script starts both the dev server and the example app.
