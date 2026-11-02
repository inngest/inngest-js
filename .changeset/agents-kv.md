---
"inngest": minor
---

Tidy the experimental agents KV. `kv` has four scopes, always written out: `kv.thread`, `kv.run`, `kv.app` and `kv.env`, with the same methods on each; the bare `kv.get` and the `session` and `function` scopes are gone. Name a typed key with `kv.key<T>(name)` or `kv.key(name, schema)` (replacing `kvKey`), reach another thread's state with `kv.scope("thread", key)`, and use `kv.with(client)` outside a function. The store contract is `KvStore` (was `KvAdapter`), chosen with `createAgents(client, { store })` or `INNGEST_EXPERIMENTAL_KV_URL`; an agent no longer takes its own `kv`. The Redis connection no longer keeps a script alive.
