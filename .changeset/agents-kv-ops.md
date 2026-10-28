---
"inngest": minor
---

Add key expiry and set-if-absent claims to the experimental scoped KV, plus sorted indexes.

```ts
await kv.env.set("run:stop:1", "k", { ttl: 3600 });
const won = await kv.env.setIfAbsent("card:1", runId, { ttl: 600 });
await kv.env.index("improve").add("id1", Date.now());
const newest = await kv.env.index("improve").range({ order: "desc", limit: 20 });
```

- `ttl` is a whole number of seconds, at most 2^31. `update` writes without a `ttl`, so it drops one.
- `setIfAbsent` returns whether the caller holds the key. A retry of the same call gets `true` because the key already holds its value, so put an owner token such as the run ID in the value.
- Index members are strings and scores are finite numbers.
- Ids that contain `%`, `:`, `|`, `{` or `}` are now escaped in stored key names.
- Custom `KvAdapter`s must implement the new methods. The Redis adapter needs Redis 6.2 or newer and reads time from the server.
