---
"inngest": patch
---

Functions using `optimizeParallelism: false` once again complete the run when the function returns, as they did in v3. In v4 this changed unintentionally: the run waited for steps you started but never awaited. If you don't use `optimizeParallelism: false`, nothing changes.

```ts
inngest.createFunction(
  { id: "example", optimizeParallelism: false, triggers: [{ event: "app/example" }] },
  async ({ step }) => {
    step.sleep("unused", "7d");

    return "done";
  },
);
```
