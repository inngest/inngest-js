---
"inngest": minor
---

Add a Durable Endpoints Next.js Adapter

```ts
// app/api/my-endpoint/route.ts
import { Inngest, step } from "inngest";
import { endpointAdapter } from "inngest/next";

const inngest = new Inngest({
  id: "my-app",
  endpointAdapter,
});

export const GET = inngest.endpoint(async (req) => {
  const foo = await step.run("my-step", () => ({ foo: "bar" }));

  return new Response(`Result: ${JSON.stringify(foo)}`);
});
```
