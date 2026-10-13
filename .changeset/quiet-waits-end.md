---
"inngest": patch
---

A run now completes when your function returns, even with steps you didn't await still pending, instead of staying open until they resolve. In a `group.parallel({ mode: "race" })`, losers still running when the function returns are cancelled when the run ends.

```ts
step.waitForEvent("unused", { event: "app/done", timeout: "7d" });

return "done";
```
