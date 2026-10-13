---
"inngest": minor
---

Experimental: code running in a sandbox can now call functions in your app. Each call is its own durable step, so it's retried and never runs twice.

```ts
const getCustomer = tool.step({
  input: z.object({ id: z.string() }),
  run: async ({ id }) => db.customers.find(id),
});

await sb.commands.run("node agent.js", { tools: { getCustomer } });
```

```js
// agent.js, inside the sandbox
const { tools } = require("inngest_tools");
const customer = await tools.getCustomer("cus_1");
```
