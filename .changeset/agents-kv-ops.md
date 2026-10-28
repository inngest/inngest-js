---
"inngest": minor
---

Add key expiry and set-if-absent claims to the experimental scoped KV (`kv.env.set(key, value, { ttl })`, `kv.env.setIfAbsent(key, value, { ttl })`), plus sorted indexes (`kv.env.index(name)` with `add`, `range` and `remove`). Custom `KvAdapter`s must implement the new methods. The Redis adapter needs Redis 6.2 or newer.
