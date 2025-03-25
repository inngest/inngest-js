---
"inngest": minor
---

Add `dependencyInjectionMiddleware()`, allowing you to easily add data to function input

```ts
import { dependencyInjectionMiddleware } from "inngest";

const prisma = new Prisma()

const inngest = new Inngest({
  id: 'my-app',
  middleware: [dependencyInjectionMiddleware({ prisma })],
});
```
