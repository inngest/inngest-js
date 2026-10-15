---
"inngest": patch
---

Experimental: code running in a sandbox can now call functions in your app. Pass `tools` to `commands.run`, and each call the code makes runs your function as its own durable step, so it's retried and memoized like any other step.

```ts
await sandbox.commands.run("agent", "node agent.js", {
  tools: {
    getCustomer: (id: string) => db.customers.find(id),
  },
});
```

```js
// agent.js, inside the sandbox
const { tools } = require("inngest_tools");
const customer = await tools.getCustomer("cus_1");
```

In Python, use `from inngest_tools import tools` and `await tools.getCustomer("cus_1")`. A tool that fails raises a `ToolError` the code can catch.
