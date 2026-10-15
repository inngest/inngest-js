---
"inngest": minor
---

Experimental: `step.sandbox.python` and `step.sandbox.typescript` now take `tools`. The code calls them as `tools.name(...)` with no import, and each call is a durable step in your app.

```ts
const total = await step.sandbox.python(
  "total",
  `customer = await tools.getCustomer(id="cus_1")
return customer["seats"] * 10`,
  { tools: { getCustomer }, schema: { output: z.number() } },
);
```
