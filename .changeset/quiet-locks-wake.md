---
"@inngest/ci": minor
---

Concurrent runs that miss the same cached job now build it once and share the result, instead of each building their own. Set how long a run waits before checking the build is still going with `buildWait`.

```ts
createCi(inngest, { buildWait: "5m" });
```

Needs `inngest` 4.23.2 or later.
