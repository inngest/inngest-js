---
"@inngest/ci": minor
---

Cached jobs can now expire with `cache.maxAge`: a snapshot older than it is rebuilt.

```ts
ci.job({ id: "base", cache: { key: files("images/node-base/**"), maxAge: "1d" } }, …);
```
