---
"inngest": minor
---

Add a new `onFunctionRun.finished` middleware hook, allowing you to hook into a run finishing successfully or failing

```ts
new InngestMiddleware({
  name: "My Middleware",
  init() {
    return {
      onFunctionRun() {
        finished({ result }) {
          // ...
        },
      },
    };
  },
});
```
