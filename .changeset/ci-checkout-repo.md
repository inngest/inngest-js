---
"@inngest/ci": minor
---

`checkout()` and `files()` can now read another repository or ref, including in runs whose trigger has no repository.

```ts
await checkout({ repo: "acme/shared-config", ref: "main" });
```
