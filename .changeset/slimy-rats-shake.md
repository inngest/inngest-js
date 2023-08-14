---
"inngest": minor
---

Add `attempt` number to SDK function context

```ts
inngest.createFunction(
  { name: "Example Function" },
  { event: "app/user.created" },
  async ({ attempt }) => {
    // ...
  }
);
```
