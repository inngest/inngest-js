---
"inngest": minor
---

Allow specifying an `env` when sending events via the client

```ts
await inngest.send({ name: "my.event" }, { env: "my-custom-env" });
```
