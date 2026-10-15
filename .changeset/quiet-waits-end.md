---
"inngest": patch
---

A run now completes when your function returns, as it did in v3. Steps you started but didn't await (a `step.waitForEvent`, `step.sleep` or `step.run`, or the losing branches of a `group.parallel({ mode: "race" })`) are no longer scheduled after the return; previously the run stayed open until they resolved. This includes functions using `optimizeParallelism: false`, whose run-on-return behaviour changed unintentionally in v4. If your function awaits all of its steps, nothing changes.

```ts
step.waitForEvent("unused", { event: "app/done", timeout: "7d" });

return "done";
```
