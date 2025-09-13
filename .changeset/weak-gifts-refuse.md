---
"inngest": minor
---

Add support for [Standard Schema](https://github.com/standard-schema/standard-schema) when specifying event types.

```ts
import { EventSchemas } from "inngest";
import { z } from "zod";

const schemas = new EventSchemas().fromSchema({
  "demo/event.sent": z.object({
    username: z.string(),
  }),
});
```

This entrypoint can be used for both Zod v3 and v4 schemas, as well as a multitude of others.

`.fromZod()` is still available, which provides some more nuanced use cases but will is deprecated in favor of `.fromSchema()`.
