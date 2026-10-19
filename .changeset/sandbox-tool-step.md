---
"inngest": patch
---

Experimental: declare a sandbox tool with `tool.step()` to give it typed, named arguments. The `input` schema is checked before anything runs, so a bad call gets a `ToolError` back in the sandbox, and `output` checks the result. A plain function in `tools` still works, and takes positional arguments.

```ts
import { tool } from "inngest/experimental";

const getCustomer = tool.step({
  input: z.object({ id: z.string() }),
  output: z.object({ name: z.string() }),
  run: async ({ id }) => db.customers.find(id),
});

await sandbox.commands.run("agent", "node agent.js", {
  tools: { getCustomer },
});
```

```js
// agent.js, inside the sandbox
const { tools } = require("inngest_tools");
const customer = await tools.getCustomer({ id: "cus_1" });
```

`tool.step()` works with `commands.run` and with the Python and TypeScript runners. Its body also receives an idempotency key that stays the same across retries, for APIs that deduplicate writes.
