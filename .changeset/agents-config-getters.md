---
"inngest": minor
---

Agent config that depends on runtime bindings can now be a function. `kv` on `agent.function()` and `getThread()` accepts a `Kv` or a function returning one, so a Worker can bind its D1 database per request. The `token` option of the Slack and GitHub channels accepts a string or a sync or async function, so `githubApp().token(...)` plugs in directly. Plain values work as before.

```ts
agent.function({ id: "triage", kv: () => createKv({ adapter: d1KvAdapter(env.DB) }), triggers: [{ event: "issue/opened" }] }, handler);
```
