---
"@inngest/realtime": minor
---

`subscribe()` call no longer accepts an `app` as the first parameter

One can be passed alongside other arguments, e.g.

```ts
subscribe({
  app,
  channel: "hello-world",
  topics: ["messages"],
});
```

An app is still required if you are not using a token retrieved from `getSubscriptionToken()`.
