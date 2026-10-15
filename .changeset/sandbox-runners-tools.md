---
"inngest": patch
---

Experimental: `step.sandbox.python` and `step.sandbox.typescript` now take `tools`. The code calls them as `tools.name(...)` with no import, and each call runs your function as a durable step.

```ts
const total = await step.sandbox.python(
  "total",
  `customer = await tools.getCustomer("cus_1")
return customer["seats"] * 10`,
  {
    tools: { getCustomer: (id: string) => db.customers.find(id) },
    schema: { output: z.number() },
  },
);
```
