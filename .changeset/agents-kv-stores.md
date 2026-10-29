---
"inngest": minor
---

Agents no longer need Redis. `createAgents(client, { store })` picks where the KV, thread state and indexes live: `redisKvAdapter(url)` (still the default, from `INNGEST_EXPERIMENTAL_KV_URL`), `d1KvAdapter(env.DB)` for Cloudflare D1, or `memoryKvAdapter()` for tests.

```ts
const agents = createAgents(client, {
  store: d1KvAdapter(() => getRequestEnv().DB),
});
```

`d1KvAdapter` takes a D1 database or a function that returns one, since a Worker's binding exists per request. Create the two tables with `d1KvSchema` in a migration. Keys past their `ttl` read as absent, and `setIfAbsent` is one SQL statement, so racing callers are arbitrated. An `update` is a read and a write on every store, so two runs updating one key at once can lose an update. `KvStore` documents what a store must guarantee.

The agents entry no longer imports `node:crypto` at load, so it loads in a Worker without `nodejs_compat`.
