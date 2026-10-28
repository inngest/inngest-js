---
"inngest": minor
---

Typed keys for the experimental scoped KV. `kvKey(name, schema)` carries the value type and validates what is read; `kvKey<T>(name)` is an explicit, unvalidated key. A plain string key now gives `unknown`, so `get<T>`, `update<T>`, `take<T>` and `all<T>` no longer take a free type argument.

```ts
const plan = kvKey("plan", z.object({ steps: z.number() }));
await kv.thread.set(plan, { steps: 3 });
const found = await kv.thread.get(plan); // { steps: number } | undefined
```

A value that fails its schema throws an error naming the key; `take` leaves such a value in place. Values are stored as JSON, so use JSON-representable types only (`z.date()` and `Map` fail on read, bigint throws on write). A schema's input and output types must match (no transforms), writes are not validated, and `all()` returns `Record<string, unknown>`. Values cannot be `undefined` (store `null`), and a stored `null` is now returned as `null` instead of `undefined`. Runs in flight across an upgrade replay `get` and `take` results in the old shape. New exports: `kvKey`, `KvKey`, `KvKeyInput`, `KvValue`, `KvRoundTrips`, `KvSchemaMustRoundTrip`. `KvHandle` is no longer exported.
